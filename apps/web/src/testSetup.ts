import { loadLocale } from "@martytv/ui";

await Promise.all([loadLocale("ru"), loadLocale("en"), loadLocale("kk")]);
