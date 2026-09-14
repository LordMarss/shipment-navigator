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
      alerts: {
        Row: {
          created_at: string
          from_status: Database["public"]["Enums"]["shipment_status"] | null
          id: string
          message: string
          shipment_id: string | null
          to_status: Database["public"]["Enums"]["shipment_status"] | null
        }
        Insert: {
          created_at?: string
          from_status?: Database["public"]["Enums"]["shipment_status"] | null
          id?: string
          message: string
          shipment_id?: string | null
          to_status?: Database["public"]["Enums"]["shipment_status"] | null
        }
        Update: {
          created_at?: string
          from_status?: Database["public"]["Enums"]["shipment_status"] | null
          id?: string
          message?: string
          shipment_id?: string | null
          to_status?: Database["public"]["Enums"]["shipment_status"] | null
        }
        Relationships: [
          {
            foreignKeyName: "alerts_shipment_id_fkey"
            columns: ["shipment_id"]
            isOneToOne: false
            referencedRelation: "shipments"
            referencedColumns: ["id"]
          },
        ]
      }
      app_settings: {
        Row: {
          created_at: string
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          created_at?: string
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          created_at?: string
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      documents: {
        Row: {
          created_at: string
          done: boolean
          file_name: string | null
          file_path: string | null
          file_type: string | null
          file_url: string | null
          id: string
          is_standard: boolean
          name: string
          shipment_id: string
          uploaded_at: string | null
        }
        Insert: {
          created_at?: string
          done?: boolean
          file_name?: string | null
          file_path?: string | null
          file_type?: string | null
          file_url?: string | null
          id?: string
          is_standard?: boolean
          name: string
          shipment_id: string
          uploaded_at?: string | null
        }
        Update: {
          created_at?: string
          done?: boolean
          file_name?: string | null
          file_path?: string | null
          file_type?: string | null
          file_url?: string | null
          id?: string
          is_standard?: boolean
          name?: string
          shipment_id?: string
          uploaded_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_shipment_id_fkey"
            columns: ["shipment_id"]
            isOneToOne: false
            referencedRelation: "shipments"
            referencedColumns: ["id"]
          },
        ]
      }
      shipment_events: {
        Row: {
          actor: string | null
          automated: boolean
          category: string
          created_at: string
          event_type: string
          field: string | null
          from_value: string | null
          id: string
          occurred_at: string
          reason: string | null
          shipment_id: string
          source: string
          to_value: string | null
        }
        Insert: {
          actor?: string | null
          automated?: boolean
          category?: string
          created_at?: string
          event_type: string
          field?: string | null
          from_value?: string | null
          id?: string
          occurred_at?: string
          reason?: string | null
          shipment_id: string
          source?: string
          to_value?: string | null
        }
        Update: {
          actor?: string | null
          automated?: boolean
          category?: string
          created_at?: string
          event_type?: string
          field?: string | null
          from_value?: string | null
          id?: string
          occurred_at?: string
          reason?: string | null
          shipment_id?: string
          source?: string
          to_value?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shipment_events_shipment_id_fkey"
            columns: ["shipment_id"]
            isOneToOne: false
            referencedRelation: "shipments"
            referencedColumns: ["id"]
          },
        ]
      }
      shipments: {
        Row: {
          actual_arrival: string | null
          actual_delivery: string | null
          actual_departure: string | null
          carrier: string | null
          client_name: string
          container_number: string | null
          created_at: string
          customer_reference: string | null
          destination: string
          eta: string | null
          health: string
          health_reason: string | null
          id: string
          landed_cost: number | null
          last_synced_at: string | null
          monitoring_start_offset_days: number | null
          monitoring_state: string
          origin: string
          planned_eta: string | null
          planned_etd: string | null
          previous_eta: string | null
          reference: string | null
          status: Database["public"]["Enums"]["shipment_status"]
          updated_at: string
          vessel_imo: string | null
          vessel_mmsi: string | null
          vessel_name: string | null
        }
        Insert: {
          actual_arrival?: string | null
          actual_delivery?: string | null
          actual_departure?: string | null
          carrier?: string | null
          client_name: string
          container_number?: string | null
          created_at?: string
          customer_reference?: string | null
          destination: string
          eta?: string | null
          health?: string
          health_reason?: string | null
          id?: string
          landed_cost?: number | null
          last_synced_at?: string | null
          monitoring_start_offset_days?: number | null
          monitoring_state?: string
          origin: string
          planned_eta?: string | null
          planned_etd?: string | null
          previous_eta?: string | null
          reference?: string | null
          status?: Database["public"]["Enums"]["shipment_status"]
          updated_at?: string
          vessel_imo?: string | null
          vessel_mmsi?: string | null
          vessel_name?: string | null
        }
        Update: {
          actual_arrival?: string | null
          actual_delivery?: string | null
          actual_departure?: string | null
          carrier?: string | null
          client_name?: string
          container_number?: string | null
          created_at?: string
          customer_reference?: string | null
          destination?: string
          eta?: string | null
          health?: string
          health_reason?: string | null
          id?: string
          landed_cost?: number | null
          last_synced_at?: string | null
          monitoring_start_offset_days?: number | null
          monitoring_state?: string
          origin?: string
          planned_eta?: string | null
          planned_etd?: string | null
          previous_eta?: string | null
          reference?: string | null
          status?: Database["public"]["Enums"]["shipment_status"]
          updated_at?: string
          vessel_imo?: string | null
          vessel_mmsi?: string | null
          vessel_name?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      shipment_status:
        | "Scheduled"
        | "Booked"
        | "Departed"
        | "In Transit"
        | "Approaching Destination"
        | "Arrived"
        | "At Port"
        | "Cleared Customs"
        | "Delivered"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      shipment_status: [
        "Scheduled",
        "Booked",
        "Departed",
        "In Transit",
        "Approaching Destination",
        "Arrived",
        "At Port",
        "Cleared Customs",
        "Delivered",
      ],
    },
  },
} as const
