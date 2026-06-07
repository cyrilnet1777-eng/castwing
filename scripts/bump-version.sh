#!/bin/bash
# Auto-bump APP_BUILD in js/constants.js and ?v= params in index.html
# Format: YYYY-MM-DDx where x is a letter suffix (a, b, c, ...)

set -e

CONSTANTS="js/constants.js"
INDEX="index.html"
TODAY=$(date +%Y-%m-%d)

# Read current version
CURRENT=$(grep -o "APP_BUILD = '[^']*'" "$CONSTANTS" | sed "s/APP_BUILD = '//;s/'//")

if [[ "$CURRENT" == "$TODAY"* ]]; then
  # Same day — increment letter suffix
  SUFFIX="${CURRENT#$TODAY}"
  if [[ -z "$SUFFIX" ]]; then
    NEXT="${TODAY}a"
  else
    NEXT_CHAR=$(echo "$SUFFIX" | tr 'a-y' 'b-z')
    NEXT="${TODAY}${NEXT_CHAR}"
  fi
else
  # New day
  NEXT="${TODAY}a"
fi

# Version tag for cache busting (no dashes)
VTAG=$(echo "$NEXT" | tr -d '-')

# Update constants.js
sed -i '' "s/APP_BUILD = '[^']*'/APP_BUILD = '${NEXT}'/" "$CONSTANTS"

# Update ?v= params in index.html
sed -i '' "s/styles\.css?v=[^\"']*/styles.css?v=${VTAG}/g" "$INDEX"
sed -i '' "s/app\.js?v=[^\"']*/app.js?v=${VTAG}/g" "$INDEX"

# Stage the bumped files
git add "$CONSTANTS" "$INDEX"

echo "Version bumped: ${CURRENT} → ${NEXT}"
