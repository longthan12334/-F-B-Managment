-- =============================================================================
--  Migration 007 — Guest order feedback + Staff calls (BE-2)
-- =============================================================================

CREATE TABLE IF NOT EXISTS guest_order_feedback (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guest_order_id  UUID NOT NULL UNIQUE REFERENCES guest_orders(id) ON DELETE CASCADE,
    rating          SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_guest_order_feedback_rating ON guest_order_feedback(rating);

CREATE TABLE IF NOT EXISTS staff_calls (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_session_id  UUID NOT NULL REFERENCES guest_table_sessions(id) ON DELETE CASCADE,
    table_code        TEXT NOT NULL,
    reason            TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','acknowledged','done')),
    acknowledged_by   UUID REFERENCES users(id),
    acknowledged_at   TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_staff_calls_pending
    ON staff_calls(created_at DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_staff_calls_table_session ON staff_calls(table_session_id);
