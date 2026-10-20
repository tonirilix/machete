#import <AppKit/AppKit.h>
#include <cassert>
#include "../native/pasteboard.h"

int main() {
  @autoreleasepool {
    // A named pasteboard keeps the real system clipboard completely untouched.
    NSPasteboard *board = [NSPasteboard pasteboardWithUniqueName];
    NSPasteboardItem *first = [[NSPasteboardItem alloc] init];
    [first setString:@"original\n  text" forType:NSPasteboardTypeString];
    NSData *richText = [@"{\\rtf1 original}" dataUsingEncoding:NSUTF8StringEncoding];
    [first setData:richText forType:NSPasteboardTypeRTF];
    NSPasteboardItem *second = [[NSPasteboardItem alloc] init];
    NSData *binary = [NSData dataWithBytes:"\0\1\2\3" length:4];
    [second setData:binary forType:@"com.machete.test.binary"];
    [board clearContents];
    assert(([board writeObjects:@[first, second]]));
    PasteboardSnapshot saved;
    assert(snapshotPasteboard(board, saved));
    [board clearContents];
    [board setString:@"fresh selection" forType:NSPasteboardTypeString];
    NSInteger copiedCount = board.changeCount;
    assert(restorePasteboard(board, saved, copiedCount) == PasteboardRestore::Restored);
    assert(board.pasteboardItems.count == 2);
    assert([[board.pasteboardItems[0] stringForType:NSPasteboardTypeString] isEqualToString:@"original\n  text"]);
    assert([[board.pasteboardItems[0] dataForType:NSPasteboardTypeRTF] isEqualToData:richText]);
    assert([[board.pasteboardItems[1] dataForType:@"com.machete.test.binary"] isEqualToData:binary]);

    assert(snapshotPasteboard(board, saved));
    [board clearContents];
    [board setString:@"selection" forType:NSPasteboardTypeString];
    copiedCount = board.changeCount;
    [board clearContents];
    [board setString:@"copied by the user later" forType:NSPasteboardTypeString];
    assert(restorePasteboard(board, saved, copiedCount) == PasteboardRestore::Changed);
    assert([[board stringForType:NSPasteboardTypeString] isEqualToString:@"copied by the user later"]);

    [board clearContents];
    assert(snapshotPasteboard(board, saved));
    [board setString:@"temporary selection" forType:NSPasteboardTypeString];
    assert(restorePasteboard(board, saved, board.changeCount) == PasteboardRestore::Restored);
    assert(board.pasteboardItems.count == 0);
    [board releaseGlobally];
    puts("Native pasteboard tests passed: text, rich text, binary/multiple items, empty clipboard, and newer-copy protection.");
  }
}
