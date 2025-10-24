import { createClient } from "@supabase/supabase-js";
const supabaseUrl = process.env.SUPABASE_URL_ROOTLINK;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY_ROOTLINK;
if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("❌ Missing SUPABASE_URL_ROOTLINK or SUPABASE_SERVICE_ROLE_KEY_ROOTLINK");
}
export const supabase = createClient(supabaseUrl, supabaseServiceKey);
