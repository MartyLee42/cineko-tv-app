import { useQuery } from "@tanstack/react-query";
import { unwrap } from "@martytv/contracts";
import { api } from "./api";

export function useDevices() {
  return useQuery({
    queryKey: ["devices"],
    queryFn: async () => (await unwrap(api.GET("/devices"))).items,
  });
}

export function useProfiles() {
  return useQuery({
    queryKey: ["profiles"],
    queryFn: async () => (await unwrap(api.GET("/profiles"))).items,
  });
}
