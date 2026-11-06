import { describe, expect, it } from "vitest";
import { isAdminRole, isSuperAdminRole } from "./roles";

describe("roles", () => {
  it("orders user < admin < super_admin", () => {
    expect(isAdminRole("user")).toBe(false);
    expect(isAdminRole("admin")).toBe(true);
    expect(isAdminRole("super_admin")).toBe(true);
    expect(isAdminRole(undefined)).toBe(false);
    expect(isSuperAdminRole("admin")).toBe(false);
    expect(isSuperAdminRole("super_admin")).toBe(true);
  });
});
