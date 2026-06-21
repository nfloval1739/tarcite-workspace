#!/bin/bash
# Copy manifest to all possible Word locations on macOS

MANIFEST="$HOME/Library/Group Containers/UBF8T346G9.Office/User Content/My Addins/citation-workspace-manifest.xml"

FOLDERS=(
  "$HOME/Library/Group Containers/UBF8T346G9.Office/User Content/My Addins"
  "$HOME/Library/Containers/com.microsoft.Word/Data/Documents/wef"
  "$HOME/Library/Containers/com.microsoft.Word/Data/Library/Application Support/wef"
)

echo "Copying manifest to all Word add-in folders..."

for folder in "${FOLDERS[@]}"; do
  mkdir -p "$folder"
  cp "$MANIFEST" "$folder/citation-workspace-manifest.xml"
  echo "  Copied to: $folder"
done

echo ""
echo "Done! Now in Word:"
echo "1. Insert → Get Add-ins"
echo "2. My Add-ins → Developer Add-ins"
echo "3. Click + and select:"
echo "   $MANIFEST"
