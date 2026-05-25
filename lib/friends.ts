"use client";

import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/lib/database.types";
import { getProfileByUsername } from "@/lib/profile";

export type Friendship = Tables<"friendships">;

export type FriendshipWithProfile = Friendship & {
  other: {
    id: string;
    username: string;
  };
};

/**
 * Lists every friendship row where `userId` is the requester or addressee.
 * Joins the "other" profile so the UI can render a name and link.
 */
export async function listFriendships(
  userId: string,
): Promise<FriendshipWithProfile[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("friendships")
    .select(
      `id, requester_id, addressee_id, status, created_at,
       requester:profiles!friendships_requester_id_fkey ( id, username ),
       addressee:profiles!friendships_addressee_id_fkey ( id, username )`,
    )
    .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
    .order("created_at", { ascending: false });

  if (error) throw error;

  type Row = Friendship & {
    requester: { id: string; username: string } | null;
    addressee: { id: string; username: string } | null;
  };

  return (data as unknown as Row[]).map((r) => {
    const other =
      r.requester_id === userId ? r.addressee : r.requester;
    return {
      id: r.id,
      requester_id: r.requester_id,
      addressee_id: r.addressee_id,
      status: r.status,
      created_at: r.created_at,
      other: other ?? { id: "", username: "(unknown)" },
    };
  });
}

/**
 * Returns the friendship row between two users (in either direction),
 * or null if none exists. Used to figure out whether to render
 * "Add friend" / "Friends" / "Request pending" on someone else's profile.
 */
export async function getFriendshipBetween(
  a: string,
  b: string,
): Promise<Friendship | null> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("friendships")
    .select("*")
    .or(
      `and(requester_id.eq.${a},addressee_id.eq.${b}),and(requester_id.eq.${b},addressee_id.eq.${a})`,
    )
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Sends a friend request from the signed-in user to `addresseeId`.
 * Throws a friendly Error on duplicates / self-requests.
 */
export async function sendFriendRequest(
  requesterId: string,
  addresseeId: string,
): Promise<void> {
  if (requesterId === addresseeId) {
    throw new Error("You cannot send a friend request to yourself.");
  }
  const supabase = createClient();
  const { error } = await supabase.from("friendships").insert({
    requester_id: requesterId,
    addressee_id: addresseeId,
    status: "pending",
  });
  if (error) {
    if (
      (error as { code?: string }).code === "23505" ||
      /duplicate/i.test(error.message)
    ) {
      throw new Error("A friendship or request already exists.");
    }
    throw error;
  }
}

/**
 * Looks up a user by username and sends a friend request to them.
 */
export async function sendFriendRequestByUsername(
  requesterId: string,
  username: string,
): Promise<void> {
  const target = await getProfileByUsername(username.trim());
  if (!target) {
    throw new Error(`No user named "${username}".`);
  }
  await sendFriendRequest(requesterId, target.id);
}

export async function acceptFriendRequest(
  friendshipId: number,
): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase
    .from("friendships")
    .update({ status: "accepted" })
    .eq("id", friendshipId);
  if (error) throw error;
}
