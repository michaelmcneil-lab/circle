// Supabase project used for sign-in and sync. Both values are meant to be public:
// the key only allows what the database's row-level security rules permit, and
// those rules only let a signed-in user read and write their own data.
// Leave them empty to run Circle on this device only, with no sync.
window.CIRCLE_CONFIG = {
  supabaseUrl: 'https://qiabotcewbolzzxxqyjc.supabase.co',
  supabaseKey: 'sb_publishable_oiVsU2JynPFZ-p6hfujcoQ_JP-r4sEr',
  // Public half of the key notifications are signed with (the private half is a Supabase secret).
  vapidPublicKey: 'BKkc7tZMRKfj9QsY1J35TsuE2mzTqKku-wKFR2y6LCuBw8mv3Ao_tCO-tW6ezaZdjK28d6Rt4poQJgYeqeiwUN0',
};
