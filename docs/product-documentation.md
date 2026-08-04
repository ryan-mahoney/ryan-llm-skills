# Product Documentation Skills

Three skills write product documentation. Each skill writes one kind of file. The later skills read the files that the earlier skills write.

## What each skill writes

| Skill | Writes | Answers |
|---|---|---|
| `build-permission-model` | `docs/permissions/permission-model.md` | Who can open which page? |
| `build-screen-inventory` | `docs/screen-inventory.md` and `docs/inventories/*.md` | Which pages exist, and for whom? |
| `document-screen-behavior` | `docs/screens/SCRN-###-*.md` | What does one page do? |

## The order

Run the skills in this order:

1. `build-permission-model`
2. `build-screen-inventory`
3. `document-screen-behavior`

The permission model is first because the other two skills need it. It records the roles, the capabilities of each role, and the guard on each page route.

The screen inventory is second. It divides the pages into groups. One group holds the pages that one audience can reach. The permission model supplies the audience rules.

The screen documents are last. Each document describes one screen in full. The inventory shows which screens have no document yet.

## The files

```text
docs/
├── permissions/
│   └── permission-model.md         <- skill 1 writes
├── screen-inventory.md             <- skill 2 writes
├── inventories/
│   └── <name>-screens.md           <- skill 2 writes
├── screens/
│   └── SCRN-001-<name>.md          <- skill 3 writes
└── screenshots/
    └── SCRN-001/*.png              <- skill 3 writes
```

## What passes between them

| From | To | What passes |
|---|---|---|
| Permission model | Screen inventory | The audience rules (`AUD-##`) |
| Permission model | Screen document | The role IDs (`ROLE-##`) and capability IDs (`CAP-##`) |
| Screen inventory | Screen document | The screen ID, and the list of pages with no document |

Each file records the version of the file that it read. The key is `derived_from`. If an earlier file changes, you can see which later files are old.

## How to run them

To document a product for the first time, do these steps:

1. Run `build-permission-model`. Read the findings before you continue.
2. Run `build-screen-inventory`. Make sure that each route is in one inventory.
3. Run `document-screen-behavior` one time for each screen.

Step 3 is long. One run writes one screen document. Start with the screens that users open most.

## When you need only one skill

You do not always need all three.

| You want | Run |
|---|---|
| To know who can open a page | `build-permission-model` |
| A list of every page | `build-screen-inventory` |
| A full description of one page | `document-screen-behavior` |

Each skill runs alone.

## When a file is absent

Each skill looks for the files that come before it. If a file is absent, the skill does that work itself. Then it records that the file was absent, and it recommends the skill that writes the file.

This behavior keeps each skill usable alone. The result is less exact than a full run.

## When the code and the documents disagree

The code is correct. A document can be old.

If a skill finds a difference, it reports the difference. It does not correct the earlier document quietly. A quiet correction makes two documents that disagree forever.

## How to keep them current

Each file records the version of the code that a person read it against. The key is `verified_against`.

Each file also records the commands that rebuild its raw input. Use these commands to see what changed. Then update only the parts that changed.

The permission model changes least often. It changes when a person adds a role. This change is rare and quiet. Read the model again after each release.
