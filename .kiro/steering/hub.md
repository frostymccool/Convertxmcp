# Project Hub

All projects are tracked in the shared project hub.

**Vault:** My Syncing Personal Vault
**Hub path:** `/Users/Me/Documents/My Syncing Personal Vault/project-hub/`
**Gitea:** http://gitea:3000/ian/project-hub

## This project

- **Name:** Convertxmcp
- **Docs:** `project-hub/projects/Convertxmcp/`
- **Progress log:** `project-hub/progress/Convertxmcp-PROGRESS.md`
- **Remotes:** `origin` = GitHub (`https://github.com/frostymccool/Convertxmcp`, primary/public, has CI) and `gitea` = Gitea (`http://gitea:3000/ian/Convertxmcp`, mirror for hub alignment) — push both on session-end, not just whichever the current branch tracks

## How to manage projects

Read `project-hub/HOW-TO-MANAGE.md` for full instructions — file conventions, README frontmatter format, how to add new projects, and how to sync.

At the end of every session, append a dated entry to this project's PROGRESS.md:
```
## YYYY-MM-DD
**Done:** ...
**Next:** ...
```

Then run `bash "/Users/Me/Documents/My Syncing Personal Vault/project-hub/sync.sh"` to push the hub to Gitea.
