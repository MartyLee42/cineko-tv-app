import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@martytv/contracts";

const GET = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ api: { GET, POST: vi.fn(), PATCH: vi.fn(), PUT: vi.fn(), DELETE: vi.fn() } }));
vi.mock("../catalog/queries", () => ({ queryClient: {} }));

describe("getSource", () => {
  it("an OK answer without a body is an error, not a source", async () => {
    const { getSource } = await import("./data");
    GET.mockResolvedValueOnce({ data: undefined, response: new Response(null, { status: 200 }) });
    await expect(getSource("s1")).rejects.toBeInstanceOf(ApiError);
    GET.mockResolvedValueOnce({ data: { id: "s1", status: "ready" }, response: new Response("{}", { status: 200 }) });
    await expect(getSource("s1")).resolves.toMatchObject({ status: "ready" });
  });
});
