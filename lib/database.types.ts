export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      chat_messages: {
        Row: {
          created_at: string
          game_code: string
          id: number
          message: string
          player_id: string
          player_name: string
        }
        Insert: {
          created_at?: string
          game_code: string
          id?: never
          message: string
          player_id: string
          player_name: string
        }
        Update: {
          created_at?: string
          game_code?: string
          id?: never
          message?: string
          player_id?: string
          player_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      friendships: {
        Row: {
          addressee_id: string
          created_at: string
          id: number
          requester_id: string
          status: string
        }
        Insert: {
          addressee_id: string
          created_at?: string
          id?: never
          requester_id: string
          status: string
        }
        Update: {
          addressee_id?: string
          created_at?: string
          id?: never
          requester_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "friendships_addressee_id_fkey"
            columns: ["addressee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "friendships_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      game_events: {
        Row: {
          action: string
          created_at: string
          game_code: string
          id: number
          metadata: Json | null
          player_id: string
        }
        Insert: {
          action: string
          created_at?: string
          game_code: string
          id?: never
          metadata?: Json | null
          player_id: string
        }
        Update: {
          action?: string
          created_at?: string
          game_code?: string
          id?: never
          metadata?: Json | null
          player_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "game_events_game_code_fkey"
            columns: ["game_code"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["game_code"]
          },
          {
            foreignKeyName: "game_events_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      game_players: {
        Row: {
          coins: number
          game_code: string
          player_id: string
          revealed_count: number
          seat_order: number
        }
        Insert: {
          coins?: number
          game_code: string
          player_id: string
          revealed_count?: number
          seat_order: number
        }
        Update: {
          coins?: number
          game_code?: string
          player_id?: string
          revealed_count?: number
          seat_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "game_players_game_code_fkey"
            columns: ["game_code"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["game_code"]
          },
          {
            foreignKeyName: "game_players_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      games: {
        Row: {
          cards_per_player: number
          challenge_passes: string[]
          created_at: string
          current_turn_player_id: string
          game_code: string
          lose_influence_reason: string | null
          next_game_code: string | null
          pending_action: string | null
          pending_action_target_id: string | null
          pending_ambassador_draw: string[] | null
          pending_block_role: string | null
          pending_blocker_id: string | null
          pending_challenger_id: string | null
          pending_target_id: string | null
          randomize_turn_order: boolean
          role_counts: Json
          status: string
          turn_phase: string
          winner_id: string | null
        }
        Insert: {
          cards_per_player?: number
          challenge_passes?: string[]
          created_at?: string
          current_turn_player_id: string
          game_code: string
          lose_influence_reason?: string | null
          next_game_code?: string | null
          pending_action?: string | null
          pending_action_target_id?: string | null
          pending_ambassador_draw?: string[] | null
          pending_block_role?: string | null
          pending_blocker_id?: string | null
          pending_challenger_id?: string | null
          pending_target_id?: string | null
          randomize_turn_order?: boolean
          role_counts?: Json
          status?: string
          turn_phase?: string
          winner_id?: string | null
        }
        Update: {
          cards_per_player?: number
          challenge_passes?: string[]
          created_at?: string
          current_turn_player_id?: string
          game_code?: string
          lose_influence_reason?: string | null
          next_game_code?: string | null
          pending_action?: string | null
          pending_action_target_id?: string | null
          pending_ambassador_draw?: string[] | null
          pending_block_role?: string | null
          pending_blocker_id?: string | null
          pending_challenger_id?: string | null
          pending_target_id?: string | null
          randomize_turn_order?: boolean
          role_counts?: Json
          status?: string
          turn_phase?: string
          winner_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "games_current_turn_player_id_fkey"
            columns: ["current_turn_player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "games_pending_action_target_id_fkey"
            columns: ["pending_action_target_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "games_pending_blocker_id_fkey"
            columns: ["pending_blocker_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "games_pending_challenger_id_fkey"
            columns: ["pending_challenger_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "games_pending_target_id_fkey"
            columns: ["pending_target_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "games_winner_id_fkey"
            columns: ["winner_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      player_influences: {
        Row: {
          game_code: string
          id: number
          is_revealed: boolean
          player_id: string
          position: number
          role: string
        }
        Insert: {
          game_code: string
          id?: never
          is_revealed?: boolean
          player_id: string
          position: number
          role: string
        }
        Update: {
          game_code?: string
          id?: never
          is_revealed?: boolean
          player_id?: string
          position?: number
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "player_influences_game_code_fkey"
            columns: ["game_code"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["game_code"]
          },
          {
            foreignKeyName: "player_influences_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      players: {
        Row: {
          desired_seat_order: number | null
          game_code: string
          id: string
          is_ready: boolean
          joined_at: string
          name: string
        }
        Insert: {
          desired_seat_order?: number | null
          game_code: string
          id: string
          is_ready?: boolean
          joined_at?: string
          name: string
        }
        Update: {
          desired_seat_order?: number | null
          game_code?: string
          id?: string
          is_ready?: boolean
          joined_at?: string
          name?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          id: string
          username: string
        }
        Insert: {
          created_at?: string
          id: string
          username: string
        }
        Update: {
          created_at?: string
          id?: string
          username?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      _ensure_profile: {
        Args: { p_email: string; p_meta: Json; p_user_id: string }
        Returns: undefined
      }
      deal_initial_influences: {
        Args: { p_game_code: string }
        Returns: undefined
      }
      draw_ambassador_cards: {
        Args: { p_game_code: string }
        Returns: string[]
      }
      get_player_game_log: {
        Args: { p_limit?: number; pid: string }
        Returns: {
          finish_position: number
          finished_at: string
          game_code: string
          total_players: number
        }[]
      }
      get_player_stats: {
        Args: { p_player_id: string }
        Returns: {
          total_games: number
          total_games_30d: number
          total_wins: number
          total_wins_30d: number
          win_pct: number
          win_pct_30d: number
        }[]
      }
      lose_influence_and_resolve: {
        Args: { p_game_code: string; p_influence_id: number }
        Returns: undefined
      }
      resolve_challenge: { Args: { p_game_code: string }; Returns: undefined }
      reveal_or_back_down: {
        Args: { p_game_code: string; p_reveal: boolean }
        Returns: undefined
      }
      set_lobby_player_order: {
        Args: { p_game_code: string; p_ordered_ids: string[] }
        Returns: undefined
      }
      submit_challenge: { Args: { p_game_code: string }; Returns: undefined }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
