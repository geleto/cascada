const SHARED_NAME_PREFIX = '$';

function renameSharedName(name) {
  if (!name) {
    return name;
  }
  return name.charAt(0) === SHARED_NAME_PREFIX ? name : `${SHARED_NAME_PREFIX}${name}`;
}

function getSharedSourceName(name) {
  return name && name.charAt(0) === SHARED_NAME_PREFIX ? name.slice(1) : name;
}

function isSharedName(name) {
  return !!name && name.charAt(0) === SHARED_NAME_PREFIX;
}

function isPrivateSharedName(name) {
  const sourceName = getSharedSourceName(name);
  return !!sourceName && sourceName.charAt(0) === '_';
}

export {SHARED_NAME_PREFIX, getSharedSourceName, isPrivateSharedName, isSharedName, renameSharedName};
