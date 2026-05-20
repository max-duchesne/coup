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
          pending_target_id: string | null
          status: string
          turn_phase: string
          winner_id: string | null
        }
        Insert: {
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
          pending_target_id?: string | null
          status?: string
          turn_phase?: string
          winner_id?: string | null
        }
        Update: {
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
          pending_target_id?: string | null
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
          game_code: string
          id: string
          is_ready: boolean
          joined_at: string
          name: string
        }
        Insert: {
          game_code: string
          id: string
          is_ready?: boolean
          joined_at?: string
          name: string
        }
        Update: {
          game_code?: string
          id?: string
          is_ready?: boolean
          joined_at?: string
          name?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      deal_initial_influences: {
        Args: { p_game_code: string }
        Returns: undefined
      }
      draw_ambassador_cards: {
        Args: { p_game_code: string }
        Returns: string[]
      }
      lose_influence_and_resolve: {
        Args: { p_game_code: string; p_influence_id: number }
        Returns: undefined
      }
      resolve_challenge: { Args: { p_game_code: string }; Returns: undefined }
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
