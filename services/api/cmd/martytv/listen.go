package main

import "github.com/gofiber/fiber/v3"

func fiberListenConfig() fiber.ListenConfig {
	return fiber.ListenConfig{DisableStartupMessage: true}
}
