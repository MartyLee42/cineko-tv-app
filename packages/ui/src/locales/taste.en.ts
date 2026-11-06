// Recommendation preferences: «О моих вкусах» (taste_note), «Минимум оценок
// у фильма» (min_votes) on web Settings / TV settings, the links from Ask AI
// and «Для вас», and the DeepSeek balance on the admin «Рекомендации» tab.
// ru must mirror en.
export const tasteEn = {
  // ---- taste note ----
  "taste.title": "About my taste",
  "taste.hint": "Describe in your own words what you like and what you don't. AI collections and Ask AI take it into account.",
  "taste.placeholder":
    "I love atmospheric thrillers and smart sci-fi, can't stand musicals and gory horror; we watch with my wife in the evenings",
  "taste.counter": "{count} / {max}",
  "taste.too_long": "At most {max} characters",
  "taste.save": "Save",
  "taste.saved": "Saved — AI collections will update shortly",
  "taste.cta": "Tell us about your taste — recommendations get better",
  "taste.cta_edit": "Your taste note",

  // ---- min votes ----
  "taste.min_votes": "Minimum ratings for a film",
  "taste.min_votes_hint": "Lower — more rare films, higher — only well-known ones.",
  "taste.min_votes.0": "No minimum",
  "taste.min_votes.n": "{n}+ ratings",
  "taste.min_votes.default": "{n}+ ratings (default)",

  // ---- TV ----
  "taste.tv.note": "About my taste",
  "taste.tv.note_empty": "Not set — press OK to write",
  "taste.tv.note_hint": "It's easier to type on your phone: Settings → About my taste.",
  "taste.tv.min_votes": "Minimum ratings",

  // ---- admin ----
  "taste.admin.balance": "DeepSeek balance: {amount}",
  "taste.admin.balance_low": "low",
  "taste.admin.balance_unavailable": "unavailable — top up the account",
  "fy.admin.trigger.taste_note": "Taste note changed",
  "taste.admin.balance_unknown": "DeepSeek balance: unknown",

  // ---- manual AI regeneration («Обновить подборки ИИ») ----
  "taste.regen": "Refresh AI picks",
  "taste.regen.hint": "Once a day · next refresh tomorrow",
  "taste.regen.hint_unlimited": "Admins: no daily limit",
  "taste.regen.running": "Refreshing AI picks…",
  "taste.regen.used": "Available tomorrow at {time}",
  "taste.regen.budget": "The AI has used up today's budget — try tomorrow",
  "taste.regen.failed": "Couldn't start the refresh. Try again later.",
  "fy.admin.trigger.user": "By user",
  "taste.regen.section": "Collections of the day",
  "taste.regen.tv_used": "Again tomorrow at {time}",

  // ---- personal notes on titles («Моя заметка», «Почему?») ----
  "taste.reason.too_slow": "Too slow",
  "taste.reason.too_scary": "Too scary",
  "taste.reason.too_violent": "Too violent",
  "taste.reason.boring_plot": "Boring plot",
  "taste.reason.bad_acting": "Bad acting",
  "taste.reason.not_my_genre": "Not my genre",
  "taste.reason.already_seen": "Already seen",
  "taste.reason.bad_ending": "Bad ending",
  "taste.reason.too_long": "Too long",
  "taste.reason.childish": "Too childish",
  "taste.reason.loved_atmosphere": "Loved the atmosphere",
  "taste.reason.great_acting": "Great acting",
  "taste.reason.smart_plot": "Smart plot",
  "taste.reason.funny": "Funny",
  "taste.reason.beautiful": "Beautifully shot",
  "taste.why": "Why?",
  "taste.why_hint": "Tell us why — future picks get better",
  "taste.reasons.dislike": "What didn't work",
  "taste.reasons.like": "What you liked",
  "taste.note.title": "My note",
  "taste.note.private": "Only this profile sees it. It helps recommendations.",
  "taste.note.placeholder": "What did you think? (optional)",
  "taste.note.add": "Add a note",
  "taste.note.edit": "Edit",
  "taste.note.save": "Save note",
  "taste.note.saved": "Note saved",
  "taste.note.delete": "Delete note",
  "taste.note.counter": "{count} / 1000",
  "taste.notes.title": "My notes",
  "taste.notes.subtitle": "Your private reactions to titles — they help recommendations.",
  "taste.notes.empty": "No notes yet. Rate a title or press «Not interested» and tell us why.",
  "taste.notes.more": "Show more",
  "taste.adjust.title": "From your notes",
  "taste.adjust.too_scary": "Fewer scary titles ({genres}): {n} notes say «too scary»",
  "taste.adjust.childish": "Fewer family & animated titles: {n} notes say «too childish»",
  "taste.adjust.too_long": "Shorter titles preferred (over {minutes} min ranked lower): {n} notes say «too slow / too long»",
  "taste.tv.why": "Why not interesting?",
  "taste.tv.why_hint": "Pick reasons with OK — or press Done.",
  "taste.tv.why_text": "Add a comment",
  "taste.tv.why_done": "Done",
} as const;
