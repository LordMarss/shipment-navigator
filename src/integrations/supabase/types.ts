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
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      alerts: {
        Row: {
          created_at: string
          dedupe_key: string | null
          from_status: Database["public"]["Enums"]["shipment_status"] | null
          id: string
          message: string
          shipment_id: string | null
          to_status: Database["public"]["Enums"]["shipment_status"] | null
        }
        Insert: {
          created_at?: string
          dedupe_key?: string | null
          from_status?: Database["public"]["Enums"]["shipment_status"] | null
          id?: string
          message: string
          shipment_id?: string | null
          to_status?: Database["public"]["Enums"]["shipment_status"] | null
        }
        Update: {
          created_at?: string
          dedupe_key?: string | null
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
      ports: {
        Row: {
          active: boolean
          country: string | null
          created_at: string
          geofence_radius_km: number
          id: string
          latitude: number
          longitude: number
          name: string
          port_type: string
          source: string
          source_identifier: string | null
          unlocode: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          country?: string | null
          created_at?: string
          geofence_radius_km?: number
          id?: string
          latitude: number
          longitude: number
          name: string
          port_type?: string
          source?: string
          source_identifier?: string | null
          unlocode?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          country?: string | null
          created_at?: string
          geofence_radius_km?: number
          id?: string
          latitude?: number
          longitude?: number
          name?: string
          port_type?: string
          source?: string
          source_identifier?: string | null
          unlocode?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      shipment_events: {
        Row: {
          actor: string | null
          automated: boolean
          category: string
          created_at: string
          dedupe_key: string | null
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
          dedupe_key?: string | null
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
          dedupe_key?: string | null
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
      shipment_notes: {
        Row: {
          author: string | null
          body: string
          created_at: string
          id: string
          shipment_id: string
          updated_at: string
        }
        Insert: {
          author?: string | null
          body: string
          created_at?: string
          id?: string
          shipment_id: string
          updated_at?: string
        }
        Update: {
          author?: string | null
          body?: string
          created_at?: string
          id?: string
          shipment_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shipment_notes_shipment_id_fkey"
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
          ais_pending_since: string | null
          ais_pending_status:
            | Database["public"]["Enums"]["shipment_status"]
            | null
          automation_hold_until: string | null
          carrier: string | null
          client_name: string
          container_number: string | null
          created_at: string
          customer_reference: string | null
          destination: string
          destination_port_id: string | null
          eta: string | null
          health: string
          health_reason: string | null
          id: string
          landed_cost: number | null
          last_synced_at: string | null
          monitoring_start_offset_days: number | null
          monitoring_state: string
          origin: string
          origin_port_id: string | null
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
          ais_pending_since?: string | null
          ais_pending_status?:
            | Database["public"]["Enums"]["shipment_status"]
            | null
          automation_hold_until?: string | null
          carrier?: string | null
          client_name: string
          container_number?: string | null
          created_at?: string
          customer_reference?: string | null
          destination: string
          destination_port_id?: string | null
          eta?: string | null
          health?: string
          health_reason?: string | null
          id?: string
          landed_cost?: number | null
          last_synced_at?: string | null
          monitoring_start_offset_days?: number | null
          monitoring_state?: string
          origin: string
          origin_port_id?: string | null
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
          ais_pending_since?: string | null
          ais_pending_status?:
            | Database["public"]["Enums"]["shipment_status"]
            | null
          automation_hold_until?: string | null
          carrier?: string | null
          client_name?: string
          container_number?: string | null
          created_at?: string
          customer_reference?: string | null
          destination?: string
          destination_port_id?: string | null
          eta?: string | null
          health?: string
          health_reason?: string | null
          id?: string
          landed_cost?: number | null
          last_synced_at?: string | null
          monitoring_start_offset_days?: number | null
          monitoring_state?: string
          origin?: string
          origin_port_id?: string | null
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
        Relationships: [
          {
            foreignKeyName: "shipments_destination_port_id_fkey"
            columns: ["destination_port_id"]
            isOneToOne: false
            referencedRelation: "ports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipments_origin_port_id_fkey"
            columns: ["origin_port_id"]
            isOneToOne: false
            referencedRelation: "ports"
            referencedColumns: ["id"]
          },
        ]
      }
      vessel_positions: {
        Row: {
          cog: number | null
          latitude: number
          longitude: number
          mmsi: string
          nav_status: string | null
          position_timestamp: string | null
          received_at: string
          sog: number | null
          source: string
          true_heading: number | null
          updated_at: string
          vessel_name: string | null
        }
        Insert: {
          cog?: number | null
          latitude: number
          longitude: number
          mmsi: string
          nav_status?: string | null
          position_timestamp?: string | null
          received_at?: string
          sog?: number | null
          source?: string
          true_heading?: number | null
          updated_at?: string
          vessel_name?: string | null
        }
        Update: {
          cog?: number | null
          latitude?: number
          longitude?: number
          mmsi?: string
          nav_status?: string | null
          position_timestamp?: string | null
          received_at?: string
          sog?: number | null
          source?: string
          true_heading?: number | null
          updated_at?: string
          vessel_name?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      apply_automation_decision: {
        Args: {
          p_shipment_id: string
          p_expected_status: Database["public"]["Enums"]["shipment_status"]
          p_new_status: Database["public"]["Enums"]["shipment_status"]
          p_expected_monitoring_state: string
          p_new_monitoring_state: string
          p_expected_pending_status?:
            | Database["public"]["Enums"]["shipment_status"]
            | null
          p_expected_pending_since?: string | null
          p_new_pending_status?:
            | Database["public"]["Enums"]["shipment_status"]
            | null
          p_new_pending_since?: string | null
          p_update_pending?: boolean
          p_source?: string
          p_actor?: string
          p_reason?: string | null
          p_monitoring_reason?: string | null
          p_status_dedupe_key?: string | null
          p_occurred_at?: string | null
          p_stamp_actual_departure?: string | null
          p_stamp_actual_arrival?: string | null
          p_alert_message?: string | null
        }
        Returns: Json
      }
      apply_manual_status_change: {
        Args: {
          p_shipment_id: string
          p_new_status: Database["public"]["Enums"]["shipment_status"]
          p_expected_status?:
            | Database["public"]["Enums"]["shipment_status"]
            | null
          p_event_type?: string
          p_reason?: string | null
          p_actor?: string
          p_alert_message?: string | null
        }
        Returns: Json
      }
      resume_shipment_automation: {
        Args: { p_shipment_id: string; p_actor?: string }
        Returns: Json
      }
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
  graphql_public: {
    Enums: {},
  },
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
