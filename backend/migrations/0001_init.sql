-- Migration number: 0001 	 2025-09-11T06:28:26.131Z
DROP TABLE IF EXISTS jobs;
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL,          
  language TEXT NOT NULL,
  leetcode_id TEXT,
  algo TEXT,
  playback_url TEXT,
  stream_uid TEXT,
  message TEXT
);
CREATE INDEX idx_jobs_status ON jobs(status);
