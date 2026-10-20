#import <AppKit/AppKit.h>

@interface CopyView : NSView
@property(nonatomic, copy) NSString *payload;
@end
@implementation CopyView
- (BOOL)acceptsFirstResponder { return YES; }
- (void)copy:(id)sender {
  NSPasteboard *board = NSPasteboard.generalPasteboard;
  [board clearContents];
  [board setString:self.payload forType:NSPasteboardTypeString];
}
- (void)drawRect:(NSRect)rect {
  [@"Selection capture test — Copy fallback" drawAtPoint:NSMakePoint(20, 120)
    withAttributes:@{NSFontAttributeName: [NSFont systemFontOfSize:18]}];
}
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *mode = argc > 1 ? @(argv[1]) : @"direct";
    NSString *payload = argc > 2 ? @(argv[2]) : @"fixture selection";
    NSApplication *app = NSApplication.sharedApplication;
    [app setActivationPolicy:NSApplicationActivationPolicyRegular];
    NSMenu *menu = [[NSMenu alloc] init];
    NSMenuItem *editItem = [[NSMenuItem alloc] init];
    NSMenu *edit = [[NSMenu alloc] initWithTitle:@"Edit"];
    [edit addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
    editItem.submenu = edit;
    [menu addItem:editItem];
    app.mainMenu = menu;
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 180, 620, 280)
      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
      backing:NSBackingStoreBuffered defer:NO];
    window.title = @"Cliptoboards selection fixture";
    if ([mode isEqualToString:@"fallback"]) {
      CopyView *view = [[CopyView alloc] initWithFrame:window.contentView.bounds];
      view.payload = payload;
      view.accessibilityElement = YES;
      view.accessibilityRole = NSAccessibilityGroupRole;
      window.contentView = view;
      [window makeFirstResponder:view];
    } else {
      NSTextView *view = [[NSTextView alloc] initWithFrame:window.contentView.bounds];
      view.string = payload;
      view.font = [NSFont userFixedPitchFontOfSize:16];
      window.contentView = view;
      [window makeFirstResponder:view];
      [view setSelectedRange:NSMakeRange(0, [mode isEqualToString:@"empty"] ? 0 : payload.length)];
    }
    [window makeKeyAndOrderFront:nil];
    [app activateIgnoringOtherApps:YES];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
      printf("READY\n"); fflush(stdout);
    });
    [app run];
  }
}
