# Hermes LinkedIn Capture API Contract

This document is the implementation contract between the Hermes Laravel application and the internal Chrome extension. The application base URL is `https://hermes.laravel-demo.cloud`. The stable extension ID is `acddngimkgljedjnlbdjnlahoafbchni`.

All `/api/extension/*` requests and responses use JSON except the successful logout response, which has no body. Clients send `Accept: application/json` and, for requests with a body, `Content-Type: application/json`.

Every request the extension makes — authenticated or not, popup or background — also sends:

```http
X-Hermes-Extension-Version: 1.4.0
```

This is the version from the installed extension's `manifest.json` (read at runtime via `chrome.runtime.getManifest().version`), not a hardcoded value. The server does not require this header to process a request; it is informational and used by the version-gate endpoint below.

## Contract summary

| Method | Route | Authentication | Success |
| --- | --- | --- | --- |
| `GET` | `/extension/auth/start` | Browser session / existing Google SSO flow | Redirect to the extension callback with a one-time code |
| `POST` | `/api/extension/auth/exchange` | One-time exchange code | `200` with a Sanctum token and user |
| `GET` | `/api/extension/me` | Sanctum bearer token | `200` with user |
| `GET` | `/api/extension/version` | None | `200` always, with supportability |
| `POST` | `/api/extension/profiles` | Sanctum bearer token with `extension:capture` | `201` queued, `200` duplicate, or `200` unsupported version |
| `POST` | `/api/extension/auth/logout` | Sanctum bearer token | `204`, current token revoked |

## Browser authentication flow

### `GET /extension/auth/start`

This is a browser-facing route in `routes/web.php`, not a JSON API route. It starts the application's existing Google SSO flow. It must use the normal Laravel web session while Google OAuth is in progress.

Authentication: no bearer token. If the browser already has an authenticated Hermes web session, the application may skip Google and issue the exchange code immediately. Otherwise, it sends the browser through the existing Google SSO flow. An exchange code must only be issued after Laravel has an authenticated user.

Success — `302 Found`:

```http
HTTP/1.1 302 Found
Location: https://acddngimkgljedjnlbdjnlahoafbchni.chromiumapp.org/callback?code=CODE
```

The callback URL is a fixed server-side constant:

```text
https://acddngimkgljedjnlbdjnlahoafbchni.chromiumapp.org/callback
```

Do not accept an arbitrary callback or return URL from the request. URL-encode `CODE` when constructing the redirect.

The raw code should be generated with a cryptographically secure random source, have roughly 256 bits of entropy, expire after approximately 60 seconds, be usable once, and be bound to the authenticated user. Store only a SHA-256 hash of the raw code. The raw value exists only long enough to put it in the redirect.

If Google SSO fails or the user cancels it, use the application's existing SSO failure handling. Do not redirect to the extension callback with a fabricated code, token, or user details.

Suggested flow:

1. Record in the web session that authentication was initiated for the extension.
2. Start the existing Google SSO route with the existing OAuth state protection.
3. After the existing callback authenticates the Laravel user, detect the extension flow.
4. Create the short-lived exchange-code record for that user.
5. Redirect to the fixed Chromium callback URL with the raw code.

The session marker should be cleared after use. It must not replace the OAuth provider's `state` validation.

## API endpoints

### `POST /api/extension/auth/exchange`

Exchanges the short-lived browser code for a Laravel Sanctum personal access token.

Authentication: none. Apply strict rate limiting by IP and code attempts.

Request:

```json
{
  "code": "ONE_TIME_CODE",
  "device_name": "chrome-extension"
}
```

Validation:

- `code`: required, string, non-empty, and reasonably length-bounded (for example, at most 512 characters).
- `device_name`: required, string, and exactly `chrome-extension`. Do not allow arbitrary user-controlled token names.
- Hash the submitted code with the same SHA-256 representation used at issuance, then look it up by `code_hash`.
- The record is valid only when it exists, `used_at` is `null`, and `expires_at` is strictly in the future.
- Consume it atomically in a database transaction using a row lock or equivalent compare-and-update. Two simultaneous requests with the same code must not both receive tokens.

Success — `200 OK`:

```json
{
  "token": "SANCTUM_PLAIN_TEXT_TOKEN",
  "user": {
    "name": "Ada Lovelace",
    "email": "ada@example.com"
  }
}
```

`token` is the one-time `plainTextToken` returned by Sanctum's `createToken`; Laravel cannot retrieve it again later.

Invalid request — `422 Unprocessable Content`:

```json
{
  "message": "The given data was invalid.",
  "errors": {
    "code": [
      "The code is invalid or has expired."
    ]
  }
}
```

Use this same generic `code` error for unknown, expired, and already-used codes. The response must not reveal which condition occurred. Ordinary field validation, including an invalid `device_name`, also returns `422` in the error envelope described below.

### `GET /api/extension/me`

Returns the user associated with the current extension token.

Authentication:

```http
Authorization: Bearer SANCTUM_PLAIN_TEXT_TOKEN
```

Success — `200 OK`:

```json
{
  "user": {
    "name": "Ada Lovelace",
    "email": "ada@example.com"
  }
}
```

Missing, invalid, expired, or revoked token — `401 Unauthorized`:

```json
{
  "message": "Unauthenticated."
}
```

The extension treats a `401` from any protected endpoint as signed out and removes its locally stored token.

### `GET /api/extension/version`

Checked by the popup on every open so an unsupported extension build can be blocked before it does anything else.

Authentication: none.

Request:

```http
GET /api/extension/version?version=1.4.0
```

`version` is the calling extension's `manifest.json` version, URL-encoded.

Response — always `200 OK`, never an error status for a well-formed request:

```json
{
  "supported": true,
  "minimum_version": "1.4.0",
  "latest_release_url": "https://github.com/laravel-gtm/hermes-extension/releases/latest"
}
```

`supported` is `false` only when the calling version is below `minimum_version`. The extension treats anything other than an explicit `200` with `supported === false` as "fail open" — network errors, timeouts, non-200 statuses, and malformed bodies all proceed with the normal popup flow rather than blocking the user.

### `POST /api/extension/profiles`

Submits one normalized LinkedIn profile URL for asynchronous capture.

Authentication:

```http
Authorization: Bearer SANCTUM_PLAIN_TEXT_TOKEN
```

Require the Sanctum token ability `extension:capture`.

Request:

```json
{
  "url": "https://www.linkedin.com/in/SLUG",
  "page": {
    "fullName": "Ada Lovelace",
    "headline": "Software Engineer at Foo",
    "location": "London, England, United Kingdom",
    "mostRecentPosition": {
      "title": "Software Engineer",
      "companyName": "Foo",
      "companyUrl": "https://www.linkedin.com/company/foo",
      "isCurrent": true,
      "dateRange": "Jan 2020 - Present · 3 yrs"
    }
  }
}
```

`page` is optional and may be `null` or absent; the extension sends it on a best-effort basis and omits or nulls it whenever the profile page couldn't be scraped. Every field inside `page` and `mostRecentPosition` (except `isCurrent`, always a boolean) is independently nullable — treat all of them as optional, unvalidated hints rather than trusted input.

Validation and normalization for `url` are defined in [LinkedIn URL validation and normalization](#linkedin-url-validation-and-normalization). `page` is not validated; the server should accept it as opaque supplementary data.

New capture — `201 Created`:

```json
{
  "status": "queued"
}
```

Persist the capture before dispatching its queue job. Dispatch after the database transaction commits so a worker cannot run before the row exists.

Already captured — `200 OK`:

```json
{
  "status": "duplicate"
}
```

Duplicate detection uses the normalized URL and must be race-safe, preferably with a database unique constraint plus an insert-or-detect-conflict operation. "Already captured" is application-wide unless Hermes's existing data model requires a tenant scope; if it does, apply that scope consistently without changing this HTTP response.

Unsupported extension version — `200 OK`:

```json
{
  "status": "unsupported_version"
}
```

Returned instead of creating a capture record when the calling extension's `X-Hermes-Extension-Version` is below the current minimum. No `page`/`url` processing occurs. The extension treats this the same as an unsupported response from `GET /api/extension/version` — it replaces the popup with the upgrade-only screen — covering the case where the minimum version was raised after the popup already loaded.

Invalid URL — `422 Unprocessable Content`:

```json
{
  "message": "The given data was invalid.",
  "errors": {
    "url": [
      "The URL must be a LinkedIn profile URL."
    ]
  }
}
```

Missing/invalid/revoked token returns `401`. An authenticated token without the required ability returns `403 Forbidden` using the standard error envelope.

### `POST /api/extension/auth/logout`

Revokes only the Sanctum personal access token used for this request. It does not revoke the user's other extension devices, other personal access tokens, or Google/Hermes browser session.

Authentication:

```http
Authorization: Bearer SANCTUM_PLAIN_TEXT_TOKEN
```

Success — `204 No Content`, with no response body.

Missing/invalid/already-revoked token — `401 Unauthorized`:

```json
{
  "message": "Unauthenticated."
}
```

## LinkedIn URL validation and normalization

The server is the final trust boundary even though the extension also canonicalizes URLs.

Use a URL parser, not a substring or loose regular-expression check. Apply these rules:

- Require an absolute HTTPS URL.
- Reject embedded credentials and non-default ports.
- Accept only the exact, case-insensitive hosts `linkedin.com` and `www.linkedin.com`. Reject other subdomains and lookalike suffixes such as `linkedin.com.example.org`.
- Require the first two non-empty path segments to be `in` and a non-empty profile slug. The `in` segment is case-sensitive and canonicalized as lowercase `in`.
- Reject dot segments, encoded path separators, control characters, or a slug that becomes empty after percent-decoding. Decode the slug once, then safely percent-encode it when building the canonical URL.
- Ignore the query string and fragment. Ignore a trailing slash or path segments after the slug.
- Always store and deduplicate the canonical form `https://www.linkedin.com/in/<encoded-slug>` with no trailing slash, query, or fragment.

Examples:

| Input | Result |
| --- | --- |
| `https://www.linkedin.com/in/ada-lovelace` | `https://www.linkedin.com/in/ada-lovelace` |
| `https://linkedin.com/in/ada-lovelace/?trk=public#about` | `https://www.linkedin.com/in/ada-lovelace` |
| `https://www.linkedin.com/in/ada-lovelace/details/experience` | `https://www.linkedin.com/in/ada-lovelace` |
| `http://www.linkedin.com/in/ada-lovelace` | reject |
| `https://uk.linkedin.com/in/ada-lovelace` | reject |
| `https://www.linkedin.com/company/hermes` | reject |

Normalization must happen before validation-dependent persistence and duplicate lookup. The original unnormalized URL need not be retained because the product captures only the profile URL.

## Error envelopes

Use stable JSON error shapes; do not return HTML from `/api/extension/*` routes.

Validation and domain validation errors use Laravel's standard `422` shape:

```json
{
  "message": "The given data was invalid.",
  "errors": {
    "field": [
      "A human-readable error message."
    ]
  }
}
```

Authentication errors use:

```json
{
  "message": "Unauthenticated."
}
```

Authorization errors use:

```json
{
  "message": "This action is unauthorized."
}
```

Unexpected server failures return `500` with a generic message and no exception, stack trace, token, exchange code, or provider details. The extension only depends on the exact success shapes, the documented validation fields, and HTTP status codes.

## Sanctum requirements

Install/configure Laravel Sanctum's personal access token support and ensure the `User` model uses `Laravel\Sanctum\HasApiTokens`.

Create the extension token only after successfully consuming the exchange code:

```php
$newToken = $user->createToken(
    $validated['device_name'],
    ['extension:capture'],
);

return response()->json([
    'token' => $newToken->plainTextToken,
    'user' => [
        'name' => $user->name,
        'email' => $user->email,
    ],
]);
```

These endpoints use Sanctum personal access token authentication through `auth:sanctum`, not cookie-based SPA authentication. Do not require `/sanctum/csrf-cookie` and do not put the extension origin in Sanctum's stateful domains.

The suggested ability is `extension:capture`. Enforce it on profile submission. The `me` and `logout` routes may share the ability middleware as defense in depth, provided tokens created by this flow always receive that ability.

In Laravel 12, register Sanctum's ability middleware aliases in `bootstrap/app.php` if the application has not already done so:

```php
use Illuminate\Foundation\Configuration\Middleware;
use Laravel\Sanctum\Http\Middleware\CheckAbilities;
use Laravel\Sanctum\Http\Middleware\CheckForAnyAbility;

->withMiddleware(function (Middleware $middleware): void {
    $middleware->alias([
        'abilities' => CheckAbilities::class,
        'ability' => CheckForAnyAbility::class,
    ]);
})
```

Logout revokes only the current access token:

```php
$request->user()->currentAccessToken()->delete();

return response()->noContent();
```

If the application configures Sanctum token expiration, `401` is still the required response for an expired token. Never log raw bearer tokens or return the stored token hash.

## Exchange-code persistence

Suggested migration sketch:

```php
Schema::create('extension_auth_exchange_codes', function (Blueprint $table) {
    $table->id();
    $table->char('code_hash', 64)->unique();
    $table->foreignId('user_id')->constrained()->cascadeOnDelete();
    $table->timestamp('expires_at')->index();
    $table->timestamp('used_at')->nullable()->index();
    $table->timestamps();
});
```

The model should cast `expires_at` and `used_at` to immutable datetimes. A scheduled cleanup may delete expired or used records after a short audit window.

Issuance sketch:

```php
$rawCode = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');

ExtensionAuthExchangeCode::create([
    'code_hash' => hash('sha256', $rawCode),
    'user_id' => $request->user()->getKey(),
    'expires_at' => now()->addSeconds(60),
]);
```

Exchange sketch; the transaction and row lock are required behavior, not merely an optimization:

```php
$result = DB::transaction(function () use ($validated) {
    $exchange = ExtensionAuthExchangeCode::query()
        ->where('code_hash', hash('sha256', $validated['code']))
        ->lockForUpdate()
        ->first();

    if (! $exchange || $exchange->used_at || ! $exchange->expires_at->isFuture()) {
        throw ValidationException::withMessages([
            'code' => ['The code is invalid or has expired.'],
        ]);
    }

    $exchange->forceFill(['used_at' => now()])->save();

    $token = $exchange->user->createToken(
        $validated['device_name'],
        ['extension:capture'],
    );

    return [$token->plainTextToken, $exchange->user];
});
```

Keeping the token creation in the same transaction ensures a failed token insert does not permanently consume the code. Do not expose whether a code hash was present.

## Laravel route and controller outline

The names are illustrative and may be adapted to the application's conventions. Preserve the paths, methods, middleware behavior, and response contract.

`routes/web.php`:

```php
use App\Http\Controllers\Extension\ExtensionAuthStartController;

Route::get('/extension/auth/start', ExtensionAuthStartController::class)
    ->name('extension.auth.start');
```

The existing Google callback controller should return to a small extension completion action when the extension-flow session marker is present. That action creates the exchange code and returns the fixed Chromium redirect. Do not duplicate the application's Google account linking or user provisioning rules.

`routes/api.php`:

```php
use App\Http\Controllers\Extension\ExchangeExtensionCodeController;
use App\Http\Controllers\Extension\ExtensionProfileController;
use App\Http\Controllers\Extension\LogoutExtensionController;
use App\Http\Controllers\Extension\ShowExtensionUserController;
use Illuminate\Support\Facades\Route;

Route::prefix('extension')->group(function () {
    Route::post('/auth/exchange', ExchangeExtensionCodeController::class)
        ->middleware('throttle:extension-auth-exchange');

    Route::middleware('auth:sanctum')->group(function () {
        Route::get('/me', ShowExtensionUserController::class);
        Route::post('/profiles', ExtensionProfileController::class)
            ->middleware('abilities:extension:capture');
        Route::post('/auth/logout', LogoutExtensionController::class);
    });
});
```

Controller responsibilities:

- `ExtensionAuthStartController`: mark the extension auth intent in the web session; if already authenticated, issue a code and redirect; otherwise enter the existing Google SSO flow.
- Existing Google callback/completion action: authenticate/provision the user using current application logic, verify the OAuth state, issue the exchange code only for a valid extension intent, clear that intent, and redirect to the fixed Chromium callback.
- `ExchangeExtensionCodeController`: validate JSON, atomically consume the code, create the Sanctum token, and serialize the exact success shape.
- `ShowExtensionUserController`: serialize only `name` and `email` under `user`.
- `ExtensionProfileController`: validate and normalize the URL, insert idempotently, dispatch capture work only for a new record, and return `201 queued` or `200 duplicate`.
- `LogoutExtensionController`: delete `currentAccessToken()` and return an empty `204` response.

Use Form Request classes or equivalent validators for exchange and profile payloads. Add feature tests for every response and race-sensitive service-level tests for single-use exchange and duplicate capture behavior.

## CORS, CSRF, and extension origin

The extension popup's fetches originate from:

```text
chrome-extension://acddngimkgljedjnlbdjnlahoafbchni
```

The extension has a matching Chrome `host_permissions` entry for `https://hermes.laravel-demo.cloud/*`, so these bearer-token API routes do not use browser cookies, Laravel's SPA authentication flow, or CSRF protection. No wildcard CORS allowance is needed for the popup.

Chrome extension host permissions generally allow the popup to make the cross-origin requests. If the application or its proxy applies a restrictive CORS policy to these API paths, explicitly allow the exact extension origin above for `/api/extension/*`, the methods `GET` and `POST`, and the headers `Authorization`, `Content-Type`, and `Accept`. Do not use `*` together with credentials; credentials are not required for the API calls.

Laravel 12's global `HandleCors` middleware handles CORS preflight requests. If a custom CORS rule is needed, publish `config/cors.php` with `php artisan config:publish cors` and scope the rule to these API paths and the exact origin.

`GET /extension/auth/start` is top-level browser navigation through `chrome.identity.launchWebAuthFlow`, not an API fetch, and does not require a CORS response. Its Google OAuth callback continues to use the application's normal web-session and OAuth-state protections.

## Minimum acceptance tests

- Authentication start redirects only after a valid Hermes/Google-authenticated user exists and always targets the fixed Chromium callback.
- Issued exchange codes expire after approximately 60 seconds, are stored hashed, are user-bound, and can succeed only once under concurrent exchange attempts.
- Exchange returns exactly `token` plus `user.name` and `user.email`; invalid, expired, and used codes all return the same `422` code error.
- `me` returns the exact user shape for a valid token and `401` after revocation.
- Profile submission canonicalizes accepted LinkedIn URLs, rejects non-profile/lookalike URLs with `422`, queues a new URL with `201`, and returns `200 duplicate` without dispatching a second job.
- A token without `extension:capture` cannot submit a profile.
- Logout revokes only the current token, returns an empty `204`, and that token subsequently receives `401`.
