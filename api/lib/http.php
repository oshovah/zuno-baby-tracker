<?php
/**
 * HTTP + JSON helpers shared by all endpoints.
 *
 *  - HttpError: exception carrying an HTTP status code, a stable error CODE
 *    ('entries.notFound') and the params of its message ({minutes: 15})
 *  - bt_error_body(): the JSON error envelope {error, code?, params?}
 *  - send_json(): JSON response (unescaped unicode so German umlauts stay
 *    readable; always Cache-Control: no-store)
 *  - read_json_body(): php://input -> assoc array (400 on invalid JSON)
 *  - bt_assert_json_request(): 415 unless Content-Type is application/json
 *
 * Error messages are German. Every throw site also names a code: the
 * frontend (src/api.js) shows its own translation of the code when it has
 * one (src/i18n/locales/<lang>/api.js — the German entry must stay
 * identical to the message here) and the message verbatim otherwise, as
 * older shells do. Numbers in a message (limits, minutes) travel as params
 * so the translation can place them.
 *
 * Target: PHP 7.4+ (cyon shared hosting).
 */

class HttpError extends RuntimeException
{
    /** @var int */
    public $status;

    /** @var string|null Stable dotted code named by meaning ('auth.throttled'); the locale key of the message. */
    public $code;

    /** @var array The message's variable parts by placeholder name ({minutes} => 15); [] when there are none. */
    public $params;

    public function __construct(int $status, string $message, ?string $code = null, array $params = [])
    {
        parent::__construct($message);
        $this->status = $status;
        $this->code = $code;
        $this->params = $params;
    }
}

/**
 * The JSON error envelope: {error: message} plus, when a code is set,
 * {code} and — only when there are any — {params}. An error without a code
 * is {error} alone, and `error` is always there: the one field a shell that
 * knows no codes reads.
 */
function bt_error_body(string $message, ?string $code = null, array $params = []): array
{
    $body = ['error' => $message];
    if ($code !== null) {
        $body['code'] = $code;
        if ($params !== []) {
            $body['params'] = $params;
        }
    }
    return $body;
}

/**
 * Send a JSON response. Every API answer is `no-store`: responses carry key
 * material, encrypted rows and session state that must never sit in a shared
 * or browser cache (the service worker never caches /api/ either).
 */
function send_json($data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

/**
 * Decode a raw JSON request body (bt_decode_json_body is the testable
 * half; read_json_body reads php://input into it).
 * Empty body -> []; a scalar/null body also degrades to [].
 * Malformed JSON -> 400 with the decoder's reason as a param.
 */
function bt_decode_json_body(string $raw): array
{
    if ($raw === '') {
        return [];
    }
    $decoded = json_decode($raw, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        $reason = json_last_error_msg();
        throw new HttpError(400, 'Ungültiger JSON-Body: ' . $reason, 'request.badJson', ['reason' => $reason]);
    }
    return is_array($decoded) ? $decoded : [];
}

/** Read and decode the JSON request body (see bt_decode_json_body). */
function read_json_body(): array
{
    $raw = file_get_contents('php://input');
    return bt_decode_json_body($raw === false ? '' : $raw);
}

/**
 * 415 unless the request declares a JSON body (Content-Type starting with
 * application/json). A browser cannot send that header cross-site without a
 * CORS preflight, so this closes the cross-site <form enctype="text/plain">
 * hole: SameSite=Lax does not stop a top-level POST, and login/register would
 * otherwise SET the attacker's cookie on the victim.
 */
function bt_assert_json_request(): void
{
    $type = $_SERVER['CONTENT_TYPE'] ?? ($_SERVER['HTTP_CONTENT_TYPE'] ?? '');
    if (!is_string($type) || stripos($type, 'application/json') !== 0) {
        throw new HttpError(415, 'Ungültiger Content-Type – JSON erwartet', 'request.badContentType');
    }
}
