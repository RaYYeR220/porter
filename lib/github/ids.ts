/** The one place a GitHub login becomes an Otari end-user id. GitHub logins are case-insensitive. */
export const endUserIdForLogin = (login: string): string => `gh:${login.toLowerCase()}`;
