package foryou

import "testing"

func TestQuizBoostsAndMerge(t *testing.T) {
	a := QuizAnswers{"genres_like": {"878"}, "genres_dislike": {"10749"}, "intensity": {"avoid"}, "origins": {"soviet"}, "eras": {"old"}}
	tt := &Taste{Genres: []Affinity{{Key: "878", Score: 0.7, Count: 3}, {Key: "27", Score: 0.5, Count: 2}}}
	applyQuiz(tt, a)
	if tt.genreScore(878) != 1 || tt.genreScore(27) >= 0 || tt.genreScore(10749) >= 0 {
		t.Fatalf("genres %+v", tt.Genres)
	}
	if tt.decadeScore(1955) <= 0 || tt.countryScore([]string{"SU"}) <= 0 || tt.langScore("ru") <= 0 {
		t.Fatalf("decades %+v countries %+v", tt.Decades, tt.Countries)
	}
	for i := 1; i < len(tt.Genres); i++ {
		if tt.Genres[i].Score > tt.Genres[i-1].Score {
			t.Fatalf("not sorted %+v", tt.Genres)
		}
	}
	if f := validateQuizAnswers(QuizAnswers{"audio": {"voiceover", "original"}, "mood": {"nope"}}); len(f) != 2 {
		t.Fatalf("validation %v", f)
	}
	if s := quizSummary(a); len(s) != 5 || s[0] != "Likes genres: Science Fiction" {
		t.Fatalf("summary %v", s)
	}
}
