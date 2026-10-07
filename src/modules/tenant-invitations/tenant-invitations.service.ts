import {
    BadRequestException,
    ConflictException,
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectDrizzle } from "@nestjs/drizzle";
import { EventEmitter2 } from "@nestjs/event-emitter";
import * as argon2 from "argon2";
import { and, eq, lt, lte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { TenantContext } from "@/common/tenant/tenant-context.js";
import { generateOpaqueToken, hashToken } from "@/common/utils/token.util.js";
import type { Env } from "@/config/env.schema.js";
import type { Database } from "@/database/database.type.js";
import { TenantInvitationStatus, TenantStatus } from "@/database/schema/enums.js";
import { tenantInvitations, type TenantInvitation } from "@/database/schema/tenant-invitations.js";
import { EMAIL_SENDER, type EmailSender } from "@/integrations/email/email-sender.interface.js";
import {
    TenantInvitationEvents,
    type TenantInvitationAbandonedEvent,
    type TenantInvitationEvent,
} from "@/modules/tenant-invitations/tenant-invitation.events.js";
import type { Tenant } from "@/modules/tenants/tenant.types.js";
import { TenantsService } from "@/modules/tenants/tenants.service.js";
import { UsersService, type UserWithProfile } from "@/modules/users/users.service.js";

const RESEND_COOLDOWN_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const GENERIC_FAILURE = "Invalid or expired invitation";

/**
 * The owner invitation of a tenant the super admin created. The emailed link
 * carries a long random token (only its hash is stored), so it cannot be guessed
 * and needs no attempt counter; a lapsed or lost link is replaced, never revived.
 *
 * Mails that contain the token are sent from here, straight to the email port —
 * the token is a secret and must not travel on the event bus. Everything else
 * that happens to an invitation is announced as an event.
 */
@Injectable()
export class TenantInvitationsService {
    private readonly logger = new Logger(TenantInvitationsService.name);

    constructor(
        @InjectDrizzle() private readonly db: Database,
        private readonly configService: ConfigService<Env, true>,
        private readonly tenantContext: TenantContext,
        private readonly tenantsService: TenantsService,
        private readonly usersService: UsersService,
        private readonly events: EventEmitter2,
        @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
    ) {}

    /**
     * Finds or creates the account that will own a tenant the super admin is about
     * to create. A new address gets an unusable placeholder password until the
     * invitation is accepted; `isNew` says whether an invitation (rather than a
     * plain "you were added") is needed.
     */
    async prepareOwner(email: string): Promise<{ user: UserWithProfile; isNew: boolean }> {
        const existing = await this.usersService.findByEmail(email);

        if (existing?.deletedAt) {
            throw new ConflictException(
                "This address belongs to an account awaiting deletion — its owner must reactivate it, or the grace period must run out first",
            );
        }
        if (existing) {
            return { user: existing, isNew: false };
        }

        const user = await this.usersService.createUser({ email, passwordHash: await argon2.hash(randomUUID()) });
        return { user, isNew: true };
    }

    /** Records the invitation and mails the link. Returns false when only the mail failed — the invitation stands and can be resent. */
    async issue(tenant: Tenant, user: { id: string; email: string }): Promise<boolean> {
        const { token, tokenHash } = generateOpaqueToken();
        const expiresAt = this.expiryFromNow();

        const [created] = await this.db
            .insert(tenantInvitations)
            .values({
                tenantId: tenant.id,
                userId: user.id,
                email: user.email,
                tokenHash,
                createdAccount: true,
                expiresAt,
            })
            .returning();
        this.events.emit(TenantInvitationEvents.CREATED, this.eventOf(created!));

        try {
            await this.emailSender.sendTenantOwnerInvite({
                to: user.email,
                tenantName: tenant.name,
                acceptUrl: this.acceptUrl(tenant.slug, token),
                expiresAt,
            });
            return true;
        } catch (error) {
            this.logger.error(`Invite email failed for tenant ${tenant.slug}: ${(error as Error).message}`);
            return false;
        }
    }

    /** Admin-triggered resend. Throws while the previous mail is inside its cooldown. */
    async resendForTenant(tenantId: string): Promise<void> {
        const invitation = await this.findByTenant(tenantId);
        if (!invitation) {
            throw new NotFoundException({
                code: "INVITATION_NOT_FOUND",
                message: "This tenant has no pending owner invitation",
            });
        }
        if (invitation.status === TenantInvitationStatus.ACCEPTED) {
            throw new ConflictException({
                code: "INVITE_ALREADY_ACCEPTED",
                message: "The owner has already accepted the invitation",
            });
        }
        if (!this.cooledDown(invitation)) {
            throw new HttpException(
                {
                    code: "INVITE_RESEND_COOLDOWN",
                    message: "An invitation was just sent — wait a minute before resending",
                },
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }

        await this.rotateAndSend(invitation, null);
    }

    /**
     * The invitee asking for a new link themselves (lost it, or it lapsed). Says
     * nothing about whether the address has an invitation: the caller always gets
     * the same answer, so this cannot be used to probe for accounts.
     */
    async resendForEmail(email: string): Promise<void> {
        const [invitation] = await this.db
            .select()
            .from(tenantInvitations)
            .where(
                and(
                    sql`lower(${tenantInvitations.email}) = ${email.toLowerCase()}`,
                    eq(tenantInvitations.status, TenantInvitationStatus.PENDING),
                ),
            )
            .limit(1);

        if (invitation && this.cooledDown(invitation)) {
            await this.rotateAndSend(invitation, null);
        }
    }

    /**
     * Spends a link: it must belong to a pending, unexpired invitation of an ACTIVE
     * tenant. Every failure is the same error, so a probe learns nothing. Returns
     * who accepted and for which tenant; setting the password is the caller's job.
     */
    async accept(token: string): Promise<{ userId: string; tenant: Tenant }> {
        const [invitation] = await this.db
            .select()
            .from(tenantInvitations)
            .where(eq(tenantInvitations.tokenHash, hashToken(token)))
            .limit(1);

        const tenant = invitation ? await this.tenantsService.findById(invitation.tenantId) : null;
        if (
            !invitation ||
            !tenant ||
            tenant.status !== TenantStatus.ACTIVE ||
            invitation.status !== TenantInvitationStatus.PENDING ||
            invitation.expiresAt < new Date()
        ) {
            throw new BadRequestException(GENERIC_FAILURE);
        }

        // Status in the WHERE: of two simultaneous clicks, only one gets the row.
        const [claimed] = await this.db
            .update(tenantInvitations)
            .set({ status: TenantInvitationStatus.ACCEPTED, acceptedAt: new Date() })
            .where(
                and(
                    eq(tenantInvitations.id, invitation.id),
                    eq(tenantInvitations.status, TenantInvitationStatus.PENDING),
                ),
            )
            .returning();
        if (!claimed) {
            throw new BadRequestException(GENERIC_FAILURE);
        }

        this.events.emit(TenantInvitationEvents.ACCEPTED, this.eventOf(claimed));
        return { userId: claimed.userId, tenant };
    }

    /**
     * Mails a nudge for every pending invitation that has been quiet long enough
     * and still has reminders left. The UPDATE both selects and marks them, so with
     * several app instances running this at once each invitation is claimed by
     * exactly one. A mail that then fails is logged, not retried: that reminder is
     * spent, the next one comes after the usual interval.
     */
    async sendDueReminders(): Promise<number> {
        const afterDays = this.configService.get("TENANT_INVITE_REMINDER_AFTER_DAYS", { infer: true });
        const max = this.configService.get("TENANT_INVITE_REMINDER_MAX", { infer: true });
        const now = new Date();

        const claimed = await this.db
            .update(tenantInvitations)
            .set({ reminderCount: sql`${tenantInvitations.reminderCount} + 1`, sentAt: now })
            .where(
                and(
                    eq(tenantInvitations.status, TenantInvitationStatus.PENDING),
                    lt(tenantInvitations.reminderCount, max),
                    lte(tenantInvitations.sentAt, new Date(now.getTime() - afterDays * DAY_MS)),
                ),
            )
            .returning();

        for (const invitation of claimed) {
            await this.rotateAndSend(invitation, invitation.reminderCount).catch(error =>
                this.logger.error(`Invite reminder failed for ${invitation.email}: ${(error as Error).message}`),
            );
        }
        return claimed.length;
    }

    /**
     * Removes tenants whose owner never accepted. All of these must hold, otherwise
     * the invitation is left alone: it is still pending, past the abandon age, made
     * the account itself, that account never verified its email, and the tenant has
     * no member but that owner. Tenant and account go in one transaction.
     */
    async cleanupAbandoned(): Promise<number> {
        const abandonDays = this.configService.get("TENANT_INVITE_ABANDON_DAYS", { infer: true });
        const cutoff = new Date(Date.now() - abandonDays * DAY_MS);

        const stale = await this.db
            .select()
            .from(tenantInvitations)
            .where(
                and(
                    eq(tenantInvitations.status, TenantInvitationStatus.PENDING),
                    eq(tenantInvitations.createdAccount, true),
                    lte(tenantInvitations.createdAt, cutoff),
                ),
            );

        let removed = 0;
        for (const invitation of stale) {
            try {
                const tenant = await this.removeAbandoned(invitation);
                if (tenant) {
                    removed += 1;
                    this.tenantsService.announceDeleted(tenant);
                    this.events.emit(TenantInvitationEvents.ABANDONED, {
                        ...this.eventOf(invitation),
                        tenantName: tenant.name,
                        tenantSlug: tenant.slug,
                    } satisfies TenantInvitationAbandonedEvent);
                }
            } catch (error) {
                this.logger.error(`Abandoned-invite cleanup failed for ${invitation.email}: ${(error as Error).message}`);
            }
        }
        return removed;
    }

    private async removeAbandoned(invitation: TenantInvitation): Promise<Tenant | null> {
        const owner = await this.usersService.findById(invitation.userId);
        if (owner?.emailVerifiedAt) {
            return null;
        }

        return this.tenantContext.runAsSystem(() =>
            this.db.transaction(async tx => {
                const tenant = await this.tenantsService.deleteUnclaimed(invitation.tenantId, invitation.userId, tx);
                if (!tenant) {
                    return null;
                }
                if (!(await this.usersService.deleteIfUnverified(invitation.userId, tx))) {
                    // They proved the address after all: undo the tenant removal too.
                    throw new Error("owner account is no longer an unverified placeholder");
                }
                return tenant;
            }),
        );
    }

    /**
     * Swaps in a fresh token with a full lifetime and mails it. `reminderNumber`
     * null means a plain (re)send, otherwise it is the n-th reminder.
     */
    private async rotateAndSend(invitation: TenantInvitation, reminderNumber: number | null): Promise<void> {
        const tenant = await this.tenantsService.findById(invitation.tenantId);
        if (!tenant || tenant.status !== TenantStatus.ACTIVE) {
            return;
        }

        const { token, tokenHash } = generateOpaqueToken();
        const expiresAt = this.expiryFromNow();
        await this.db
            .update(tenantInvitations)
            .set({
                tokenHash,
                expiresAt,
                // A reminder was already stamped when it was claimed; a plain resend stamps it now.
                ...(reminderNumber === null ? { sentAt: new Date() } : {}),
            })
            .where(eq(tenantInvitations.id, invitation.id));

        const message = {
            to: invitation.email,
            tenantName: tenant.name,
            acceptUrl: this.acceptUrl(tenant.slug, token),
            expiresAt,
        };
        if (reminderNumber === null) {
            await this.emailSender.sendTenantOwnerInvite(message);
        } else {
            await this.emailSender.sendTenantOwnerInviteReminder({ ...message, reminderNumber });
        }
    }

    private findByTenant(tenantId: string): Promise<TenantInvitation | undefined> {
        return this.db
            .select()
            .from(tenantInvitations)
            .where(eq(tenantInvitations.tenantId, tenantId))
            .limit(1)
            .then(([row]) => row);
    }

    private cooledDown(invitation: TenantInvitation): boolean {
        return invitation.sentAt.getTime() <= Date.now() - RESEND_COOLDOWN_MS;
    }

    private expiryFromNow(): Date {
        return new Date(Date.now() + this.configService.get("TENANT_INVITE_TTL_DAYS", { infer: true }) * DAY_MS);
    }

    private acceptUrl(slug: string, token: string): string {
        return `${this.tenantsService.urlFor(slug)}/accept-invite?token=${token}`;
    }

    private eventOf(invitation: TenantInvitation): TenantInvitationEvent {
        return {
            invitationId: invitation.id,
            tenantId: invitation.tenantId,
            userId: invitation.userId,
            email: invitation.email,
        };
    }
}
