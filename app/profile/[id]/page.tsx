"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlayer } from "@/lib/player";
import { createClient } from "@/lib/supabase/client";
import {
  getPlayerGameLog,
  getPlayerStats,
  getProfileById,
  isValidUsername,
  updateUsername,
  type GameLogEntry,
  type PlayerStats,
  type Profile,
} from "@/lib/profile";
import {
  acceptFriendRequest,
  getFriendshipBetween,
  listFriendships,
  sendFriendRequest,
  sendFriendRequestByUsername,
  type Friendship,
  type FriendshipWithProfile,
} from "@/lib/friends";
import { AuthHeader, InitialsAvatar } from "@/components/AuthHeader";
import {
  DisplayHeading,
  FieldInput,
  Frame,
  Pill,
  SmallLabel,
  Wordmark,
} from "@/components/ui";
import { M } from "@/lib/design";

export default function ProfilePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const me = usePlayer();
  const profileId = params.id;
  const isSelf = !me.loading && me.id === profileId && me.id !== "";

  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [gameLog, setGameLog] = useState<GameLogEntry[]>([]);

  useEffect(() => {
    let active = true;
    async function load() {
      setProfileLoading(true);
      setProfileError(null);
      try {
        const [p, s, log] = await Promise.all([
          getProfileById(profileId),
          getPlayerStats(profileId),
          getPlayerGameLog(profileId, 20),
        ]);
        if (!active) return;
        setProfile(p);
        setStats(s);
        setGameLog(log);
      } catch (err) {
        if (!active) return;
        setProfileError(
          err instanceof Error ? err.message : "Couldn't load profile",
        );
      } finally {
        if (active) setProfileLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [profileId]);

  return (
    <Frame>
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
        <header
          style={{
            padding: "32px 48px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <Link href="/" style={{ textDecoration: "none" }}>
            <Wordmark size={22} />
          </Link>
          <AuthHeader />
        </header>

        <main
          style={{
            flex: 1,
            display: "flex",
            justifyContent: "center",
            padding: "24px 24px 64px",
          }}
        >
          <div style={{ width: "100%", maxWidth: 760 }}>
            <button
              onClick={() => router.back()}
              style={{
                background: "none",
                border: "none",
                color: M.muted,
                fontFamily: "inherit",
                fontSize: 13,
                letterSpacing: "0.2em",
                textTransform: "uppercase",
                cursor: "pointer",
                marginBottom: 24,
                padding: 0,
              }}
            >
              ← Back
            </button>

            {profileLoading ? (
              <div style={{ color: M.muted, fontSize: 14 }}>Loading profile…</div>
            ) : profileError ? (
              <div style={{ color: M.blood, fontSize: 14 }}>{profileError}</div>
            ) : !profile ? (
              <div style={{ color: M.muted, fontSize: 14 }}>
                No profile found for this user.
              </div>
            ) : (
              <>
                <ProfileHeader
                  profile={profile}
                  isSelf={isSelf}
                  onUsernameChange={(next) =>
                    setProfile({ ...profile, username: next })
                  }
                />

                {!isSelf && me.id && !me.isAnonymous && (
                  <FriendButton
                    selfId={me.id}
                    otherId={profile.id}
                  />
                )}

                <StatsSection stats={stats} />

                <GameLogSection log={gameLog} />

                {isSelf && <FriendsSection selfId={me.id} />}
              </>
            )}
          </div>
        </main>
      </div>
    </Frame>
  );
}

// ─── Header (avatar + username + edit) ─────────────────────────────────────

function ProfileHeader({
  profile,
  isSelf,
  onUsernameChange,
}: {
  profile: Profile;
  isSelf: boolean;
  onUsernameChange: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(profile.username);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmed = value.trim();
    if (trimmed === profile.username) {
      setEditing(false);
      return;
    }
    if (!isValidUsername(trimmed)) {
      setError("Use 3–20 letters, digits or underscores.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateUsername(profile.id, trimmed);
      onUsernameChange(trimmed);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        gap: 20,
        alignItems: "center",
        marginBottom: 32,
      }}
    >
      <InitialsAvatar name={profile.username} size={72} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <FieldInput
              value={value}
              onChange={setValue}
              placeholder="username"
              maxLength={20}
              style={{ maxWidth: 320 }}
            />
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Pill
                size="sm"
                accent="gold"
                filled
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save"}
              </Pill>
              <Pill
                size="sm"
                disabled={saving}
                onClick={() => {
                  setValue(profile.username);
                  setError(null);
                  setEditing(false);
                }}
              >
                Cancel
              </Pill>
            </div>
            {error && (
              <span style={{ color: M.blood, fontSize: 12 }}>{error}</span>
            )}
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <DisplayHeading size={32}>{profile.username}</DisplayHeading>
            {isSelf && (
              <button
                onClick={() => setEditing(true)}
                style={{
                  background: "none",
                  border: "none",
                  color: M.muted,
                  fontFamily: "inherit",
                  fontSize: 12,
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                  padding: "4px 0",
                }}
              >
                Edit
              </button>
            )}
          </div>
        )}
        <SmallLabel style={{ marginTop: 6 }}>
          {isSelf ? "Your profile" : "Player"}
        </SmallLabel>
      </div>
    </div>
  );
}

// ─── Friend button (on someone else's profile) ─────────────────────────────

function FriendButton({
  selfId,
  otherId,
}: {
  selfId: string;
  otherId: string;
}) {
  const [friendship, setFriendship] = useState<Friendship | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    return getFriendshipBetween(selfId, otherId)
      .then((f) => {
        setFriendship(f);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Couldn't check status.");
        setLoading(false);
      });
  }, [selfId, otherId]);

  useEffect(() => {
    let active = true;
    getFriendshipBetween(selfId, otherId)
      .then((f) => {
        if (!active) return;
        setFriendship(f);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Couldn't check status.");
        setLoading(false);
      });

    const supabase = createClient();
    const channel = supabase
      .channel(`friend-button:${selfId}:${otherId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "friendships" },
        () => {
          getFriendshipBetween(selfId, otherId)
            .then((f) => {
              if (active) setFriendship(f);
            })
            .catch(() => {});
        },
      )
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [selfId, otherId]);

  async function send() {
    setSending(true);
    setError(null);
    try {
      await sendFriendRequest(selfId, otherId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send request.");
    } finally {
      setSending(false);
    }
  }

  async function accept() {
    if (!friendship) return;
    setSending(true);
    setError(null);
    try {
      await acceptFriendRequest(friendship.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't accept.");
    } finally {
      setSending(false);
    }
  }

  if (loading) return null;

  let inner: React.ReactNode;
  if (!friendship) {
    inner = (
      <Pill size="sm" accent="gold" filled disabled={sending} onClick={() => void send()}>
        {sending ? "Sending…" : "Add friend"}
      </Pill>
    );
  } else if (friendship.status === "accepted") {
    inner = <Pill size="sm" disabled>Friends</Pill>;
  } else if (friendship.addressee_id === selfId) {
    inner = (
      <Pill size="sm" accent="gold" filled disabled={sending} onClick={() => void accept()}>
        {sending ? "Accepting…" : "Accept friend request"}
      </Pill>
    );
  } else {
    inner = <Pill size="sm" disabled>Request pending</Pill>;
  }

  return (
    <div style={{ marginBottom: 32, display: "flex", flexDirection: "column", gap: 6 }}>
      {inner}
      {error && <span style={{ color: M.blood, fontSize: 12 }}>{error}</span>}
    </div>
  );
}

// ─── Stats grid ────────────────────────────────────────────────────────────

function StatsSection({ stats }: { stats: PlayerStats | null }) {
  if (!stats) return null;
  return (
    <section style={{ marginBottom: 40 }}>
      <SmallLabel style={{ marginBottom: 14 }}>Stats</SmallLabel>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 12,
        }}
      >
        <StatCell label="Games" value={stats.total_games} />
        <StatCell label="Wins" value={stats.total_wins} />
        <StatCell label="Win %" value={`${stats.win_pct}%`} />
        <StatCell label="Games (30d)" value={stats.total_games_30d} />
        <StatCell label="Wins (30d)" value={stats.total_wins_30d} />
        <StatCell label="Win % (30d)" value={`${stats.win_pct_30d}%`} />
      </div>
    </section>
  );
}

function StatCell({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div
      style={{
        background: M.surface,
        border: `1px solid ${M.border}`,
        borderRadius: 12,
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <span
        style={{
          fontSize: 11,
          color: M.muted,
          letterSpacing: "0.2em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 24, color: M.text, fontFamily: "inherit" }}>
        {value}
      </span>
    </div>
  );
}

// ─── Game log ──────────────────────────────────────────────────────────────

function GameLogSection({ log }: { log: GameLogEntry[] }) {
  return (
    <section style={{ marginBottom: 40 }}>
      <SmallLabel style={{ marginBottom: 14 }}>Recent games</SmallLabel>
      {log.length === 0 ? (
        <div style={{ color: M.muted, fontSize: 14 }}>No finished games yet.</div>
      ) : (
        <div
          style={{
            background: M.surface,
            border: `1px solid ${M.border}`,
            borderRadius: 12,
            overflow: "hidden",
          }}
        >
          {log.map((entry, i) => (
            <div
              key={entry.game_code + i}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "12px 18px",
                borderTop: i === 0 ? "none" : `1px solid ${M.border}`,
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ color: M.text, fontSize: 15, letterSpacing: "0.08em" }}>
                  {entry.game_code}
                </span>
                <span style={{ color: M.muted, fontSize: 12 }}>
                  {entry.finished_at
                    ? new Date(entry.finished_at).toLocaleString()
                    : "—"}
                </span>
              </div>
              <PositionBadge
                position={entry.finish_position}
                total={entry.total_players}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PositionBadge({
  position,
  total,
}: {
  position: number;
  total: number;
}) {
  const won = position === 1;
  return (
    <span
      style={{
        fontSize: 13,
        padding: "6px 12px",
        borderRadius: 999,
        border: `1px solid ${won ? M.borderHi : M.border}`,
        color: won ? M.gold : M.text,
        letterSpacing: "0.05em",
      }}
    >
      {won ? "Won" : `${position} of ${total}`}
    </span>
  );
}

// ─── Friends section (self only) ───────────────────────────────────────────

function FriendsSection({ selfId }: { selfId: string }) {
  const [friendships, setFriendships] = useState<FriendshipWithProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    return listFriendships(selfId)
      .then((rows) => {
        setFriendships(rows);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Couldn't load friends.");
        setLoading(false);
      });
  }, [selfId]);

  // Initial load + realtime: friendships table changes (RLS filters to mine).
  useEffect(() => {
    let active = true;
    listFriendships(selfId)
      .then((rows) => {
        if (!active) return;
        setFriendships(rows);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Couldn't load friends.");
        setLoading(false);
      });

    const supabase = createClient();
    const channel = supabase
      .channel(`friends:${selfId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "friendships" },
        () => {
          listFriendships(selfId)
            .then((rows) => {
              if (active) setFriendships(rows);
            })
            .catch(() => {});
        },
      )
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [selfId]);

  const accepted = useMemo(
    () => friendships.filter((f) => f.status === "accepted"),
    [friendships],
  );
  const incoming = useMemo(
    () =>
      friendships.filter(
        (f) => f.status === "pending" && f.addressee_id === selfId,
      ),
    [friendships, selfId],
  );
  const outgoing = useMemo(
    () =>
      friendships.filter(
        (f) => f.status === "pending" && f.requester_id === selfId,
      ),
    [friendships, selfId],
  );

  return (
    <section style={{ marginBottom: 40 }}>
      <SmallLabel style={{ marginBottom: 14 }}>Friends</SmallLabel>

      <AddFriendForm selfId={selfId} onSent={() => void refresh()} />

      {error && (
        <div style={{ color: M.blood, fontSize: 12, marginTop: 12 }}>{error}</div>
      )}

      {loading ? (
        <div style={{ color: M.muted, fontSize: 14, marginTop: 16 }}>
          Loading…
        </div>
      ) : (
        <>
          {incoming.length > 0 && (
            <FriendList
              title="Incoming requests"
              rows={incoming}
              renderAction={(f) => (
                <AcceptButton id={f.id} onDone={() => void refresh()} />
              )}
            />
          )}

          <FriendList
            title={accepted.length === 1 ? "1 friend" : `${accepted.length} friends`}
            rows={accepted}
            empty="No friends yet."
            renderAction={() => null}
          />

          {outgoing.length > 0 && (
            <FriendList
              title="Sent requests"
              rows={outgoing}
              renderAction={() => (
                <span style={{ color: M.muted, fontSize: 12 }}>Pending</span>
              )}
            />
          )}
        </>
      )}
    </section>
  );
}

function AddFriendForm({
  selfId,
  onSent,
}: {
  selfId: string;
  onSent: () => void;
}) {
  const [username, setUsername] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const infoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (infoTimer.current) clearTimeout(infoTimer.current);
    };
  }, []);

  async function send() {
    const u = username.trim();
    if (!u) return;
    setSending(true);
    setError(null);
    setInfo(null);
    try {
      await sendFriendRequestByUsername(selfId, u);
      setUsername("");
      setInfo(`Request sent to ${u}.`);
      if (infoTimer.current) clearTimeout(infoTimer.current);
      infoTimer.current = setTimeout(() => setInfo(null), 4000);
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send request.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <FieldInput
          value={username}
          onChange={setUsername}
          placeholder="Friend's username"
          maxLength={20}
          style={{ flex: 1, minWidth: 0 }}
        />
        <Pill
          size="sm"
          accent="gold"
          filled
          disabled={sending || !username.trim()}
          onClick={() => void send()}
        >
          {sending ? "Sending…" : "Send"}
        </Pill>
      </div>
      {error && <span style={{ color: M.blood, fontSize: 12 }}>{error}</span>}
      {info && <span style={{ color: M.good, fontSize: 12 }}>{info}</span>}
    </div>
  );
}

function FriendList({
  title,
  rows,
  empty,
  renderAction,
}: {
  title: string;
  rows: FriendshipWithProfile[];
  empty?: string;
  renderAction: (f: FriendshipWithProfile) => React.ReactNode;
}) {
  return (
    <div style={{ marginTop: 24 }}>
      <SmallLabel style={{ marginBottom: 10, color: M.mutedHi, letterSpacing: "0.2em" }}>
        {title}
      </SmallLabel>
      {rows.length === 0 ? (
        empty ? (
          <div style={{ color: M.muted, fontSize: 13 }}>{empty}</div>
        ) : null
      ) : (
        <div
          style={{
            background: M.surface,
            border: `1px solid ${M.border}`,
            borderRadius: 12,
            overflow: "hidden",
          }}
        >
          {rows.map((f, i) => (
            <div
              key={f.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "10px 14px",
                borderTop: i === 0 ? "none" : `1px solid ${M.border}`,
              }}
            >
              <Link
                href={`/profile/${f.other.id}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  textDecoration: "none",
                  color: M.text,
                  flex: 1,
                  minWidth: 0,
                }}
              >
                <InitialsAvatar name={f.other.username} size={32} />
                <span style={{ fontSize: 15 }}>{f.other.username}</span>
              </Link>
              {renderAction(f)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AcceptButton({
  id,
  onDone,
}: {
  id: number;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Pill
      size="sm"
      accent="gold"
      filled
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await acceptFriendRequest(id);
          onDone();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Accepting…" : "Accept"}
    </Pill>
  );
}
