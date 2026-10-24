/**
 * Hand-written types for backend/supabase/schema.sql.
 *
 * Once your project is set up you can replace this file with generated types:
 *   npx supabase gen types typescript --project-id <id> > src/backends/supabase/database.types.ts
 */

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          display_name: string;
          email: string | null;
          avatar_url: string | null;
          created_at: string;
        };
        Insert: {
          id: string;
          display_name: string;
          email?: string | null;
          avatar_url?: string | null;
          created_at?: string;
        };
        Update: {
          display_name?: string;
          avatar_url?: string | null;
        };
        Relationships: [];
      };
      conversations: {
        Row: ConversationRow;
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      conversation_members: {
        Row: { conversation_id: string; user_id: string; joined_at: string };
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      messages: {
        Row: MessageRow;
        Insert: {
          conversation_id: string;
          text: string;
          client_id?: string | null;
          sender_id?: string;
        };
        Update: Record<string, never>;
        Relationships: [];
      };
    };
    Views: {
      conversation_summaries: {
        Row: ConversationRow & { member_ids: string[] };
        Relationships: [];
      };
    };
    Functions: {
      get_or_create_direct_conversation: {
        Args: { other_user_id: string };
        Returns: string;
      };
      create_group_conversation: {
        Args: { group_title: string; member_ids: string[] };
        Returns: string;
      };
      is_conversation_member: {
        Args: { conv: string };
        Returns: boolean;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

// `type` (not `interface`) so rows satisfy supabase-js's Record<string, unknown> constraint.
export type ConversationRow = {
  id: string;
  title: string | null;
  is_group: boolean;
  direct_key: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_message_text: string | null;
  last_message_sender_id: string | null;
  last_message_at: string | null;
};

export type MessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string;
  text: string;
  client_id: string | null;
  created_at: string;
};
