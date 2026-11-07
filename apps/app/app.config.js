// Extends app.json. The Expo project that owns a build is chosen at run time: when EAS_PROJECT_ID is set (the Android workflows set it to the
// gotmygame-android project) it replaces extra.eas.projectId, and EAS_PROJECT_SLUG replaces slug (EAS requires both to match the project);
// otherwise app.json's values (the existing project, used by iOS and web) apply.
module.exports = ({ config }) => {
  const projectId = process.env.EAS_PROJECT_ID;
  if (!projectId) return config;
  const slug = process.env.EAS_PROJECT_SLUG || config.slug;
  return { ...config, slug, extra: { ...config.extra, eas: { ...(config.extra && config.extra.eas), projectId } } };
};
