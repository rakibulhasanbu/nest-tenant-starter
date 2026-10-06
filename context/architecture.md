Use Prisma version 7

use absolute path please

the folder architecture should be:
src/
├── config/
├── common/
├── database/
├── integrations/
├── modules/
├── app.module.ts
└── main.ts

do not add index.ts type files where all files export didnt need that.

use zod strictObject when create schema and then nestjs-zod use this to convert class dto and use in the controller and in the service use dto type which is create from the schema

Response convention: Paginated endpoints must return {data, meta:{page,limit,total}} from the service layer.

## API contract (the clients mirror this — changing it breaks them)

Authorization is permission-based. Nothing ever checks a role *name*; it checks
a permission key from `src/common/authorization/permissions.constant.ts`. Roles
are runtime rows with editable contents, so "is this role called admin" answers
the wrong question — in the clients too, which gate on
`hasPermission(user.permissions, PERMISSIONS.*)`.

Role ids are lowercase slugs (`user`, `admin`, `super_admin`). Users carry
`roleIds: string[]`; there is no `role` field on any response. Role assignment
has its own endpoint (`PATCH /admin/users/:id/roles`) — `PATCH /admin/users/:id`
is a strictObject and 400s on a role key.

Personal details live in the `user_profiles` table and are nested under
`profile` both on the way out and on `PATCH /users/me`. Flat `dateOfBirth` or
`gender` is a 400.

`toPublicUser` is the only way a `User` reaches a client, and it drops every
secret. It adds `hasPassword`, so a client can offer set-password to Google-only
accounts instead of change-password.

`/users/me` alone returns `permissions[]` and `maxRank` via `toCurrentUser` —
they describe the *requester*, so never attach them to another user's record.

`GET /auth/sessions` marks the caller's own row with `isCurrent`, derived from
the `sessionId` claim (the refresh-token family id) on their access token. That
claim is absent on tokens issued before it existed, in which case no row is
marked.

Errors are `{statusCode, code, message}`; `AllExceptionsFilter` passes through
any extra field the thrown exception attached, so a `code` can carry context the
client acts on (e.g. `ACCOUNT_PENDING_DELETION` carries `graceEndsAt`). `details`
stays reserved for `VALIDATION_ERROR`'s per-field issues.

Admin surfaces are web-only by design. The Expo app deliberately has no admin
screens — do not "fix" that.
