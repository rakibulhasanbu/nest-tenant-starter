import { Body, Controller, Get, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Public } from "@/common/decorators/public.decorator.js";
import { CreateTenantRequestDto } from "@/modules/tenant-requests/dto/create-tenant-request.schema.js";
import { TenantRequestsService } from "@/modules/tenant-requests/tenant-requests.service.js";

/** The public side: what a prospective tenant sees and submits before they have any account. */
@Controller("tenant-requests")
export class TenantRequestsController {
    constructor(private readonly requestsService: TenantRequestsService) {}

    @Public()
    @Get("config")
    config() {
        return this.requestsService.getPublicConfig();
    }

    @Public()
    @Throttle({ default: { limit: 5, ttl: 60_000 } })
    @HttpCode(HttpStatus.CREATED)
    @Post()
    create(@Body() dto: CreateTenantRequestDto) {
        return this.requestsService.create(dto);
    }
}
