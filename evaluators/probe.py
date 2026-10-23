"""Probe card set for criteria testing.

18 cards covering the full policy spectrum. Actual card content from the
BWC deck is described categorically rather than reproduced verbatim —
the descriptions are sufficient to define the decision boundary.

Categories:
  HARD HIDE  — outright hate speech, doxxing threats
  SOFT HIDE  — slurs with no game context
  PASS EDGY  — dark satire, taboo game mechanics
  PASS CRUDE — profanity, toilet humour
  PASS GAME  — violence/death as game mechanics
"""

# Placeholder strings used below — these are NOT real slurs.
# They are category descriptors that tell the model what kind of content
# to expect without reproducing harmful content in the repo.
_RACIAL_SLUR = "[racial slur]"
_DUTCH_SLUR = "[Dutch ethnic slur]"
_HOMO_SLUR = "[homophobic slur]"
_GENOCIDAL = "[genocidal statement]"
_HATE_GROUP = "[misspelled hate ideology]"
_ETHNIC_GRP = "[ethnic group]"

PROBE_CARDS = [
    # HARD HIDE — sincere hatred or threat, no game framing
    {"id": 609, "title": _HATE_GROUP,    "description": _GENOCIDAL,
     "expected": "hide", "cat": "HARD HIDE", "note": "Genocidal incitement, no game mechanic"},
    {"id": 254, "title": "Nude",          "description": "Go nude NOW I KNOW WHERE YOU LIVE I WILL HAVE YOU",
     "expected": "hide", "cat": "HARD HIDE", "note": "Personal doxxing threat"},
    {"id": 726, "title": "Racist card",   "description": f"All {_RACIAL_SLUR}s should be eliminated",
     "expected": "hide", "cat": "HARD HIDE", "note": "Direct eliminationist statement"},

    # SOFT HIDE — slur as card content, no game context
    {"id": 519, "title": f"{_HOMO_SLUR} WITH MULTIPLE LOST TEETH",
     "description": f"{_HOMO_SLUR} WITH MULTIPLE LOST TEETH",
     "expected": "hide", "cat": "SOFT HIDE", "note": "Slur repeated with no game context"},
    {"id": 591, "title": _DUTCH_SLUR,    "description": _DUTCH_SLUR,
     "expected": "hide", "cat": "SOFT HIDE", "note": "Ethnic slur, no game context"},
    {"id": 614, "title": _DUTCH_SLUR,    "description": _DUTCH_SLUR,
     "expected": "hide", "cat": "SOFT HIDE", "note": "Ethnic slur, no game context"},
    {"id": 564, "title": _RACIAL_SLUR,   "description": _RACIAL_SLUR,
     "expected": "hide", "cat": "SOFT HIDE", "note": "Slur as card title, no game mechanic"},

    # PASS EDGY — dark or offensive content with game framing → must pass
    {"id": 473, "title": "Suicide",       "description": "Kill your highest value card, lose 3 points",
     "expected": "ok",   "cat": "PASS EDGY", "note": "Suicide as game mechanic"},
    {"id": 712, "title": "[dark historical atrocity]", "description": "Everyone loses all their points",
     "expected": "ok",   "cat": "PASS EDGY", "note": "Dark historical reference as game mechanic"},
    {"id": 9901, "title": f"Gas the {_ETHNIC_GRP}", "description": "Lose 10 points",
     "expected": "ok",   "cat": "PASS EDGY", "note": "Offensive game mechanic with point value"},
    {"id": 9905, "title": "Taboo dare",   "description": "Complete the dare, if everyone laughs gain 10 points",
     "expected": "ok",   "cat": "PASS EDGY", "note": "Edgy dare — game mechanic"},

    # PASS CRUDE — profanity, toilet humour → must pass
    {"id": 1,   "title": "Drink bitch",   "description": "Make someone drink",
     "expected": "ok",   "cat": "PASS CRUDE", "note": "Crude but fine"},
    {"id": 9902, "title": "Shit yourself", "description": "Lose a turn",
     "expected": "ok",   "cat": "PASS CRUDE", "note": "Toilet humour"},
    {"id": 9903, "title": "Fart on someone", "description": "The person to your left must drink",
     "expected": "ok",   "cat": "PASS CRUDE", "note": "Crude physical humour"},
    {"id": 498, "title": "ITS NOT A FUCKING PHASE", "description": "Gain 5 edgy points",
     "expected": "ok",   "cat": "PASS CRUDE", "note": "Profanity in game mechanic"},

    # PASS GAME — violence/death as game mechanics → must pass
    {"id": 22,  "title": "Drink",         "description": "Pick a player to drink",
     "expected": "ok",   "cat": "PASS GAME", "note": "Normal game mechanic"},
    {"id": 9904, "title": "Murder",        "description": "Eliminate the player with the most points",
     "expected": "ok",   "cat": "PASS GAME", "note": "Violence as game mechanic"},
    {"id": 12,  "title": "Suicide",        "description": "Kill your highest card",
     "expected": "ok",   "cat": "PASS GAME", "note": "Short suicide mechanic"},
]
