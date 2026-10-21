// Metro config: lets the app import TypeScript sources from packages/shared.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, '../../packages/shared');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [sharedRoot];
// Resolve every dependency (including the shared package's zod) from the app's own node_modules,
// so React/React Native are never duplicated from the web workspace.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
