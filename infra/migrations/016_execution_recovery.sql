-- Resume only locks caused by this worker's uncertain order submission.
-- User lifecycle actions and hard reconciliation failures clear this intent.
ALTER TABLE bots ADD COLUMN execution_resume_requested boolean NOT NULL DEFAULT false;
