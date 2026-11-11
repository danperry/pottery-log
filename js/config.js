/* Pottery Log configuration (see README.md).
 * None of these values are secrets, so it is fine to commit them to a public repo.
 */
window.POTTERY_CONFIG = {
  // URL of your deployed sign-in Worker (worker/ folder), with no trailing slash,
  // e.g. 'https://pottery-log-auth.your-subdomain.workers.dev'. Google Drive backup
  // stays off until this is set.
  authWorkerUrl: 'https://pottery-log-auth.danperry.workers.dev',

  // OAuth 2.0 "Web application" client ID. Sign-in itself goes through the Worker; the app
  // uses this only to find the project number for the folder picker. e.g. '1234567890-abc123.apps.googleusercontent.com'
  googleClientId: '668841456155-egdtnh49ote38n7fsqae8e1dtdso19gt.apps.googleusercontent.com',

  // API key for the Google Picker (used by "Choose folder"), restricted to your site and
  // the Google Picker API, e.g. 'AIzaSy...'.
  googleApiKey: 'AIzaSyCtIGQ7aPKebZJBhBOB-m0c8NWTkJ3wuaw',

  // Cloud project number. Leave empty: it is read from the start of the client ID.
  googleAppId: '',
};
