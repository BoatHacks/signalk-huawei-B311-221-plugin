// Typed failures of the router client (ARCHITECTURE §2.1). Messages never
// contain the password, tokens or cookies.

export type AuthFailureReason =
  | "credentials-missing"
  | "username-wrong" // 108001
  | "password-wrong" // 108002
  | "credentials-wrong" // 108006
  | "lockout" // 108007: too many attempts, the router blocks logins for a while
  | "password-change-required" // 115002
  | "rejected" // other 108xxx (108004, 108005 are not documented by the reference library)
  | "unsupported-password-type";

/** Maps a login error code to a reason. Undefined for non-login codes. */
export function authReasonForCode(code: number): AuthFailureReason | undefined {
  switch (code) {
    case 108001:
      return "username-wrong";
    case 108002:
      return "password-wrong";
    case 108006:
      return "credentials-wrong";
    case 108007:
      return "lockout";
    case 115002:
      return "password-change-required";
    default:
      return code >= 108000 && code < 109000 ? "rejected" : undefined;
  }
}

/** The router rejected the login. Retrying will not help and risks lockout. */
export class AuthFailed extends Error {
  readonly reason: AuthFailureReason;
  readonly code: number | undefined;
  /** 108007: the router has locked out further login attempts. */
  readonly lockout: boolean;
  constructor(reason: AuthFailureReason, code?: number) {
    super(
      code === undefined
        ? `Router login failed: ${reason}`
        : `Router login failed: ${reason} (code ${code})`,
    );
    this.name = "AuthFailed";
    this.reason = reason;
    this.code = code;
    this.lockout = reason === "lockout";
  }
}

/**
 * The router refused the login because another admin session is active
 * (108003), for example its own web page is open. That clears by itself, so
 * unlike AuthFailed it is never latched and polling retries with backoff.
 */
export class SessionBusy extends Error {
  readonly code = 108003;
  constructor() {
    super("The router has another admin session open (108003); will retry");
    this.name = "SessionBusy";
  }
}

/** Network error or timeout: the router could not be reached. */
export class Unreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Unreachable";
  }
}

/** The router answered, but not with something we can use. */
export class BadResponse extends Error {
  /** The router's `<error><code>`, when it sent one. */
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "BadResponse";
    this.code = code;
  }
}

/** The caller asked for something invalid. Nothing was sent to the router. */
export class InvalidRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequest";
  }
}
