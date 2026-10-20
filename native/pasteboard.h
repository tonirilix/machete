#pragma once
#import <AppKit/AppKit.h>

// Materialize every item/type before sending Copy. If a promised format cannot
// be read, leave the clipboard alone rather than restoring an incomplete copy.
struct PasteboardSnapshot {
  __strong NSArray<NSPasteboardItem *> *items = nil;
  NSInteger changeCount = 0;
};

inline bool snapshotPasteboard(NSPasteboard *board, PasteboardSnapshot &snapshot) {
  snapshot.changeCount = board.changeCount;
  NSMutableArray<NSPasteboardItem *> *items = [NSMutableArray array];
  NSUInteger bytes = 0;
  for (NSPasteboardItem *item in board.pasteboardItems) {
    NSPasteboardItem *copy = [[NSPasteboardItem alloc] init];
    for (NSPasteboardType type in item.types) {
      NSData *data = [item dataForType:type];
      if (!data || data.length > 64 * 1024 * 1024 - bytes) return false;
      bytes += data.length;
      if (![copy setData:data forType:type]) return false;
    }
    [items addObject:copy];
  }
  if (board.changeCount != snapshot.changeCount) return false;
  snapshot.items = items;
  return true;
}

enum class PasteboardRestore { Restored, Changed, Failed };

inline PasteboardRestore restorePasteboard(NSPasteboard *board,
                                          const PasteboardSnapshot &snapshot,
                                          NSInteger ownedChangeCount) {
  // Never overwrite a newer copy made by the user or another app.
  if (board.changeCount != ownedChangeCount) return PasteboardRestore::Changed;
  [board clearContents];
  if (snapshot.items.count && ![board writeObjects:snapshot.items]) {
    return PasteboardRestore::Failed;
  }
  return PasteboardRestore::Restored;
}
