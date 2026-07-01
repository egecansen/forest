package com.sahibinden.web.ui.testdetails;

import com.sahibinden.core.provider.WebTestContextProvider;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.extension.AfterTestExecutionCallback;
import org.junit.jupiter.api.extension.ExtensionContext;

/**
 * Hektor flaky-triage KIT TOOL — dump the rendered DOM when a test FAILS.
 *
 * <p>Single-URL {@code dom-capture} can't reach selector breaks on flow-gated pages (payment widget,
 * classified-posting form, flag-enabled detail). This runs as an {@link AfterTestExecutionCallback}
 * (fires right after the test body, BEFORE afterEach cleanup — so the driver is still alive) and, on
 * failure, writes {@code WebTestContextProvider.get().getBrowser().getPageSource()} — the real DOM at the
 * exact failure state. Driven by {@code core/dom-on-failure.sh}; see {@code docs/.../kernel.md} (N2).
 *
 * <p>Auto-registered via JUnit autodetection (a {@code META-INF/services} file in the kit's capture-res)
 * ONLY when the kit passes {@code -Djunit.jupiter.extensions.autodetection.enabled=true}; inert unless
 * {@code -Ddump.failDir} is set, so it never affects a normal run. Failures here never break the test run.
 */
public class DomDumpOnFailure implements AfterTestExecutionCallback {

  @Override
  public void afterTestExecution(ExtensionContext ctx) {
    if (ctx.getExecutionException().isEmpty()) {
      return; // only act on failure
    }
    String dir = System.getProperty("dump.failDir", "");
    if (dir.isBlank()) {
      return; // inert unless the kit explicitly asks
    }
    try {
      String html = WebTestContextProvider.get().getBrowser().getPageSource();
      String name = ctx.getRequiredTestClass().getSimpleName() + "."
          + ctx.getRequiredTestMethod().getName();
      Path out = Path.of(dir, name + ".html");
      Files.write(out, html.getBytes(StandardCharsets.UTF_8));
      System.out.println("DOM-DUMP-ON-FAIL chars=" + html.length() + " -> " + out);
    } catch (Throwable t) {
      // driver may already be gone / no browser — never break the run; just report
      System.out.println("DOM-DUMP-ON-FAIL skipped: " + t);
    }
  }
}
