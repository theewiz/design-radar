-- ==============================================================================
-- DesignRadar Initial Schema Migration
-- Migration: 001_initial_schema.sql
-- ==============================================================================

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------------------------
-- 1. search_runs Table
-- Tracks each radar discovery execution, parameters, counts, and status.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    query_count INTEGER NOT NULL DEFAULT 0,
    result_count INTEGER NOT NULL DEFAULT 0,
    new_post_count INTEGER NOT NULL DEFAULT 0,
    candidate_count INTEGER NOT NULL DEFAULT 0,
    matched_post_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running',
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------------------
-- 2. companies Table
-- Stores companies hiring for Product Design roles.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    linkedin_url TEXT,
    website TEXT,
    post_count INTEGER NOT NULL DEFAULT 1,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(name);
CREATE INDEX IF NOT EXISTS idx_companies_linkedin_url ON companies(linkedin_url) WHERE linkedin_url IS NOT NULL;

-- ------------------------------------------------------------------------------
-- 3. recruiters Table
-- Stores hiring managers and recruiters discovered across posts.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruiters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    linkedin_url TEXT UNIQUE,
    post_count INTEGER NOT NULL DEFAULT 1,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recruiters_name ON recruiters(name);
CREATE INDEX IF NOT EXISTS idx_recruiters_linkedin_url ON recruiters(linkedin_url) WHERE linkedin_url IS NOT NULL;

-- ------------------------------------------------------------------------------
-- 4. linkedin_posts Table
-- Core repository of discovered and classified LinkedIn posts.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS linkedin_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    search_run_id UUID REFERENCES search_runs(id) ON DELETE SET NULL,
    source_provider TEXT,
    linkedin_url TEXT NOT NULL UNIQUE,
    author_name TEXT,
    company_name TEXT,
    job_title TEXT,
    seniority TEXT,
    location TEXT,
    remote_status TEXT,
    post_text TEXT,
    application_url TEXT,
    is_hiring_manager_or_recruiter BOOLEAN,
    published_at TIMESTAMPTZ,
    discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    relevance_score INTEGER NOT NULL DEFAULT 0,
    is_recruiting_post BOOLEAN NOT NULL DEFAULT false,
    is_product_design_role BOOLEAN NOT NULL DEFAULT false,
    confidence NUMERIC(4,3),
    classification_reason TEXT,
    source_query TEXT,
    status TEXT NOT NULL DEFAULT 'qualified' CHECK (status IN ('qualified', 'stale', 'irrelevant', 'low_confidence')),
    is_notified BOOLEAN NOT NULL DEFAULT false,
    sent_to_whatsapp BOOLEAN NOT NULL DEFAULT false,
    sent_at TIMESTAMPTZ,
    notified_at TIMESTAMPTZ,
    notification_channel TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for performance, querying, and digest delivery
CREATE INDEX IF NOT EXISTS idx_linkedin_posts_url ON linkedin_posts(linkedin_url);
CREATE INDEX IF NOT EXISTS idx_linkedin_posts_published_at ON linkedin_posts(published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_linkedin_posts_discovered_at ON linkedin_posts(discovered_at DESC);
CREATE INDEX IF NOT EXISTS idx_linkedin_posts_relevance_score ON linkedin_posts(relevance_score DESC);
CREATE INDEX IF NOT EXISTS idx_linkedin_posts_sent_to_whatsapp ON linkedin_posts(sent_to_whatsapp);
CREATE INDEX IF NOT EXISTS idx_linkedin_posts_is_notified ON linkedin_posts(is_notified);
CREATE INDEX IF NOT EXISTS idx_linkedin_posts_company ON linkedin_posts(company_name);
CREATE INDEX IF NOT EXISTS idx_linkedin_posts_seniority ON linkedin_posts(seniority);
CREATE INDEX IF NOT EXISTS idx_linkedin_posts_status ON linkedin_posts(status);
CREATE INDEX IF NOT EXISTS idx_linkedin_posts_search_run ON linkedin_posts(search_run_id);

-- ------------------------------------------------------------------------------
-- 5. notifications Table
-- Records every digest sent, recipient, post count, and delivery status.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_type TEXT NOT NULL DEFAULT 'daily_digest',
    post_count INTEGER NOT NULL DEFAULT 0,
    post_ids UUID[] NOT NULL DEFAULT '{}',
    recipient TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_message_id TEXT,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'sent',
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_sent_at ON notifications(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);

-- ------------------------------------------------------------------------------
-- Automated updated_at Trigger
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_linkedin_posts_updated_at ON linkedin_posts;
CREATE TRIGGER trg_linkedin_posts_updated_at
    BEFORE UPDATE ON linkedin_posts
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_companies_updated_at ON companies;
CREATE TRIGGER trg_companies_updated_at
    BEFORE UPDATE ON companies
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_recruiters_updated_at ON recruiters;
CREATE TRIGGER trg_recruiters_updated_at
    BEFORE UPDATE ON recruiters
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
