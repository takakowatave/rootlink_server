import { createClient } from "@supabase/supabase-js";

export function getSupabase() {
    const url = process.env.SUPABASE_URL_ROOTLINK;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY_ROOTLINK;

    if (!url || !key) {
        throw new Error("Supabase env is missing");
    }

    return createClient(url, key);
}
