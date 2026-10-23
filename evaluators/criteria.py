"""Production moderation criteria for Strands Decider.

v4 criteria: principle-based, no verbatim examples.
Achieves 7/7 hide recall and 9/11 ok specificity on the probe set.

See PROMPT_EXPERIMENTS.md for the full experiment history.
"""

HARM_THRESHOLD = 0.55
NO_VALUE_THRESHOLD = 0.36

HARM_QUESTION = {
    "type": "choice",
    "instructions": (
        "You are reviewing cards for a sandbox party card game with no formal rules. "
        "The game is intentionally irreverent — dark humour, satire, crude content, "
        "caricature, historical references, and offensive game mechanics are all "
        "normal and welcome. Players are encouraged to be provocative. "
        "Your job is narrow: identify cards that express sincere real-world hatred "
        "directed at a group of people, or sincere personal threats against an individual. "
        "Artistic critique, satire, dark game mechanics, and offensive humour are "
        "explicitly permitted. Judge intent and framing, not topic alone."
    ),
    "criteria": {
        "hide": (
            "HIDE only if the card expresses sincere, targeted real-world hatred or threat "
            "with no satirical, artistic, or game framing. Two patterns qualify:\n"
            "(1) A sincere call for the elimination of or violence against a real ethnic, "
            "religious, or national group — not as a game mechanic or satirical device, "
            "but as a genuine expression of hatred or incitement. The tell: no game effect, "
            "no point value, no satirical distance — just the statement itself.\n"
            "(2) A personal threat that includes identifying information about a real "
            "individual (location, address, or personal details suggesting intent to harm).\n"
            "The test: does this read as something a person genuinely means as a real-world "
            "statement of hatred or threat, rather than as a provocative game card?"
        ),
        "ok": (
            "KEEP in all other cases, including:\n"
            "dark game mechanics using violence, death, or tragedy as point effects or rules;\n"
            "satire and caricature of public or historical figures, however harsh;\n"
            "crude, offensive, or taboo language used as a dare or game action;\n"
            "dark humour involving sensitive topics when framed as game mechanic or "
            "satirical commentary rather than sincere personal belief;\n"
            "controversial political or social content expressed as critique or humour;\n"
            "anything where the framing suggests a game card rather than a sincere "
            "real-world statement. When in doubt, keep."
        ),
    },
}
