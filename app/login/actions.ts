"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type AuthFormState = {
  error: string | null;
  /** When true, UI should suggest switching to the Google tab. */
  suggestGoogle?: boolean;
} | null;

export async function signInWithPassword(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // "Invalid login credentials" is ambiguous — it covers both wrong password
    // AND accounts that were created via Google (no password set). Surface a
    // hint so users don't get stuck.
    const isCredentialError =
      error.message.toLowerCase().includes("invalid login") ||
      error.message.toLowerCase().includes("invalid credentials");

    return {
      error: isCredentialError
        ? "Incorrect email or password."
        : error.message,
      suggestGoogle: isCredentialError,
    };
  }

  revalidatePath("/", "layout");
  redirect("/");
}

export async function signUpWithPassword(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const displayName = String(formData.get("displayName") ?? "").trim();

  if (!email || !password) {
    return { error: "Email and password are required." };
  }
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: displayName ? { full_name: displayName } : undefined,
    },
  });

  if (error) {
    // "User already registered" — returned when email confirmation is OFF.
    const isAlreadyRegistered =
      error.message.toLowerCase().includes("already registered") ||
      error.message.toLowerCase().includes("already been registered") ||
      error.message.toLowerCase().includes("user already exists");

    return {
      error: isAlreadyRegistered
        ? "An account with this email already exists."
        : error.message,
      suggestGoogle: isAlreadyRegistered,
    };
  }

  // When email confirmation is ON, Supabase silently returns "success" for
  // duplicate emails (to prevent enumeration) but sets `identities` to [].
  // A real new user always has at least one identity entry.
  if (data.user?.identities?.length === 0) {
    return {
      error: "An account with this email already exists.",
      suggestGoogle: true,
    };
  }

  return { error: "Check your email to confirm your account, then sign in." };
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
