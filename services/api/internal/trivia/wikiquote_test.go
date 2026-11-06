package trivia

import "testing"

func TestParseQuotes(t *testing.T) {
	page := `<!-- comment -->
== Цитаты ==
=== Уолт ===
* Химию нужно уважать.<ref>Серия 1</ref>
* Да, сука! ().
== Другие ==
* Джесси: Йо, мистер Уайт!
* Крейзи-8: Открой замок, Уолтер. Уолт: А потом?
* Майк: Больше никаких полумер.
** Сезон 3, серия 13
== Диалоги ==
* Уолт: Кто ты?<br>Гус: Друг.
== В ролях ==
* Брайан Крэнстон — Уолтер Уайт
`
	got := parseQuotes(page)
	want := []struct{ text, speaker string }{
		{"Химию нужно уважать.", "Уолт"},
		{"Йо, мистер Уайт!", "Джесси"},
		{"Больше никаких полумер.", "Майк"},
		{"Да, сука!", "Уолт"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d quotes: %+v", len(got), got)
	}
	for i, w := range want {
		if got[i].Text != w.text || got[i].Speaker == nil || *got[i].Speaker != w.speaker {
			t.Errorf("quote %d = %q / %v, want %q / %q", i, got[i].Text, got[i].Speaker, w.text, w.speaker)
		}
	}
}

func TestTemplateText(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{`{{q|Тук-тук, Нео.|Оригинал=Knock, knock, Neo.}}`, "Тук-тук, Нео."},
		{`{{Q|Оригинал=x|Следуй за [[Алиса|белым]] кроликом|Комментарий={{lang-en|y}}}}`, "Следуй за [[Алиса|белым]] кроликом"},
		{`* not a template`, ""},
	} {
		if got, _ := templateText(c.in); got != c.want {
			t.Errorf("templateText(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestClean(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{`[''At a [[w:Telephone booth|phonebooth]]''] '''Dodge this.'''`, "Dodge this."},
		{`Только [[w:хиллбилли]] его используют <…> вот.`, "Только хиллбилли его используют … вот."},
		{`Текст&nbsp;с {{lang-en|x}} [https://a.b ссылкой] .`, "Текст с ссылкой."},
	} {
		if got := clean(c.in); got != c.want {
			t.Errorf("clean(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
