# Short aliases for the scripts (§21.4). Server: run with sudo.
.PHONY: help install setup harden start stop restart status logs update backup seed security tunnel dev check e2e

help:
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-10s %s\n", $$1, $$2}'

install: ## install Docker, cloudflared, tools; create /opt/dubroom
	./scripts/install.sh
setup: ## interactive setup wizard (.env, secrets, tunnel, autostart)
	./scripts/setup.sh
harden: ## server hardening (§22)
	./scripts/harden.sh
start: ## start the stack
	./scripts/start.sh
stop: ## graceful stop (running rounds finish)
	./scripts/stop.sh
restart: ## stop + start
	./scripts/restart.sh
status: ## health report
	./scripts/status.sh
logs: ## logs of all services (make logs s=api)
	./scripts/logs.sh $(s) -f
update: ## backup → update → smoke test (rollback on failure)
	./scripts/update.sh
backup: ## backup now
	./scripts/backup.sh
seed: ## import the starter clip pack
	./scripts/seed-clips.sh content/starter-pack --approve
security: ## security audit
	./scripts/security-check.sh
tunnel: ## tunnel info
	./scripts/tunnel.sh info
dev: ## local development with hot reload
	./scripts/dev.sh
check: ## everything CI checks
	pnpm check && LANG=C.UTF-8 shellcheck scripts/*.sh scripts/lib/*.sh && pnpm -F @dubroom/help check
e2e: ## browser tests (needs ./scripts/dev.sh --seed running)
	pnpm e2e
