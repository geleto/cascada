const SHARED_NAME_PREFIX = '$';
const TEMPLATE_TEXT_CHANNEL_NAME = '__text__';

function renameSharedName(name) {
  if (!name || name === TEMPLATE_TEXT_CHANNEL_NAME) {
    return name;
  }
  return name.charAt(0) === SHARED_NAME_PREFIX ? name : `${SHARED_NAME_PREFIX}${name}`;
}

function getSharedSourceName(name) {
  return name && name.charAt(0) === SHARED_NAME_PREFIX ? name.slice(1) : name;
}

function isSharedName(name, scriptMode = true) {
  return !!name && (
    name.charAt(0) === SHARED_NAME_PREFIX ||
    (!scriptMode && name === TEMPLATE_TEXT_CHANNEL_NAME)
  );
}

function isPrivateSharedName(name) {
  const sourceName = getSharedSourceName(name);
  return !!sourceName && sourceName.charAt(0) === '_';
}

export {SHARED_NAME_PREFIX, getSharedSourceName, isPrivateSharedName, isSharedName, renameSharedName};
