/** Account roles, least to most privileged: user < admin < super_admin. */
export type Role = "user" | "admin" | "super_admin";

/** Administrator rights (admin or super_admin): the Admin page and every admin endpoint. */
export function isAdminRole(role: string | null | undefined): boolean {
  return role === "admin" || role === "super_admin";
}

/** super_admin: also manages administrators and sees every device and pairing request. */
export function isSuperAdminRole(role: string | null | undefined): boolean {
  return role === "super_admin";
}
