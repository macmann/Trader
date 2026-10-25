# Admin accounts and workspace plans

After deployment, platform administrators can open **Admin Users** from the sidebar. Search by email or workspace name to see account verification, join/login times, workspace plans, bot/connection counts and monthly AI/backtest usage. Each owned workspace has its own row. The directory does not expose passwords, sessions or exchange credentials, and does not impersonate users.

Choose **Manage plan**, select FREE, BASIC or PRO, enter your own administrator password and confirm. The change takes effect on subsequent entitlement checks without a restart. Manual assignments remain effective independently of billing subscription status/events. Choose **Use billing / default plan** to remove the assignment and return to the effective billing plan (FREE for inactive/expired billing).

Only platform operators can access these controls. An organization/workspace Admin role does not grant platform-wide access. The API checks operator authorization, origin/CSRF and password confirmation; database functions restrict cross-tenant access to the account directory and plan operation. Every successful change records its actor, workspace, previous assignment and new assignment in the target workspace audit log.

Downgrades keep existing bots, exchange connections, positions and historical records. New resources and usage are limited by the new plan. Existing entry execution can also be blocked when the workspace exceeds its bot allowance. Risk checks, order cancellation/reconciliation and supported position exits retain their existing behavior. Plan changes never liquidate positions or enable Live trading.

## First setup administrator

Migration 012 preserves the earliest existing platform operator as the installation owner. On fresh installations, the first successful setup captures the owner automatically. Later operators do not receive this entitlement automatically.

The installation owner's **personal workspace** has protected UNLIMITED subscription allowances: bot/connection counts, paper sessions, strategy subscriptions and monthly AI/research usage are not gated by FREE/BASIC/PRO quotas. The Subscription screen and admin directory show this entitlement. Its plan cannot be downgraded from the UI/API, and billing events cannot remove it. Organization workspaces retain separate workspace plans.

Unlimited subscription allowances do not bypass capital allocation, position sizing, portfolio risk limits, exchange restrictions, emergency controls or the platform AI daily spending budget. Those remain separately configured controls. No new environment variables are required.
