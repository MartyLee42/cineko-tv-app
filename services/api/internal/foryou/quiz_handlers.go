package foryou

import (
	"errors"
	"strconv"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/httpx"
)

// Taste quiz routes (quiz.go): /profiles/{id}/taste-quiz…, for everyone
// who may use the profile (its account and its TVs).

func (s *Service) hQuiz(c fiber.Ctx) error {
	pid, err := s.usableParam(c)
	if err != nil {
		return err
	}
	st, err := s.QuizState(c.Context(), pid)
	if err != nil {
		return err
	}
	return c.JSON(st)
}

func (s *Service) hQuizTitles(c fiber.Ctx) error {
	pid, err := s.usableParam(c)
	if err != nil {
		return err
	}
	lang, err := langOf(c)
	if err != nil {
		return err
	}
	limit := 10
	if v := c.Query("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 30 {
			return httpx.Validation(map[string]string{"limit": "must be 1–30"})
		}
		limit = n
	}
	items, err := s.QuizTitles(c.Context(), pid, lang, limit)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"items": items})
}

func (s *Service) hQuizAnswers(c fiber.Ctx) error {
	pid, err := s.usableParam(c)
	if err != nil {
		return err
	}
	var in struct {
		Questions QuizAnswers       `json:"questions"`
		Titles    []QuizTitleAnswer `json:"titles"`
	}
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	f := validateQuizAnswers(in.Questions)
	for k, v := range validateQuizTitles(in.Titles) {
		f[k] = v
	}
	if len(f) > 0 {
		return httpx.Validation(f)
	}
	st, err := s.QuizAnswer(c.Context(), pid, in.Questions, in.Titles)
	if errors.Is(err, errQuizUnknownTitle) {
		return httpx.Validation(map[string]string{"titles.media_id": "unknown title"})
	}
	if err != nil {
		return err
	}
	return c.JSON(st)
}

func (s *Service) hQuizFinish(c fiber.Ctx) error {
	pid, err := s.usableParam(c)
	if err != nil {
		return err
	}
	lang, err := langOf(c)
	if err != nil {
		return err
	}
	st, ai, err := s.QuizFinish(c.Context(), pid, lang)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"state": st, "ai_regeneration": ai})
}

func (s *Service) hQuizDismiss(c fiber.Ctx) error {
	pid, err := s.usableParam(c)
	if err != nil {
		return err
	}
	st, err := s.QuizDismiss(c.Context(), pid)
	if err != nil {
		return err
	}
	return c.JSON(st)
}

// hQuizGenerate: «✨ Заполнить по моим фильмам» (quiz_generate.go). Too
// little history → 409 not_enough_history.
func (s *Service) hQuizGenerate(c fiber.Ctx) error {
	pid, err := s.usableParam(c)
	if err != nil {
		return err
	}
	lang, err := langOf(c)
	if err != nil {
		return err
	}
	res, err := s.QuizGenerate(c.Context(), pid, lang)
	if errors.Is(err, errQuizNotEnough) {
		return httpx.Conflict("not_enough_history", "Rate or watch at least "+strconv.Itoa(QuizGenMinTitles)+" titles first.")
	}
	if err != nil {
		return err
	}
	return c.JSON(res)
}
