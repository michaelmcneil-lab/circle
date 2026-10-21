// Supabase project used for sign-in and sync. Both values are meant to be public:
// the key only allows what the database's row-level security rules permit, and
// those rules only let a signed-in user read and write their own data.
// Leave them empty to run Circle on this device only, with no sync.
window.CIRCLE_CONFIG = {
  supabaseUrl: '',
  supabaseKey: '',
};
