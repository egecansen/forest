package com.sahibinden.web.ui.testdetails;

import com.sahibinden.web.TestDataResource;
import com.sahibinden.web.annotation.AutowiredBean;
import com.sahibinden.web.annotation.test.ParameterizedWebTest;
import com.sahibinden.web.client.website.page.home.HomePage;
import com.sahibinden.web.util.suite.tag.MainTag;
import com.sahibinden.web.util.suite.tag.MainTag.Kure;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Stream;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Tags;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.context.annotation.Description;

/**
 * Hektor flaky-triage KIT TOOL — NOT a coverage test, and NOT part of the suite tree.
 *
 * <p>This file lives entirely in the kit ({@code .cursor/skills/hektor-flaky-triage/core/capture-src/})
 * and is sourced into gradle ONLY at capture time by {@code core/capture.init.gradle} (an
 * {@code --init-script} that adds capture-src as a test source root). Normal CI builds never see it,
 * so it has zero suite footprint; it runs inside the real gradle test JVM, reusing the framework's
 * proven Selenoid/testbox driver wiring. Driven by {@code core/dom-capture.sh}; see
 * {@code docs/hektor/flaky-triage-kit/kernel.md} (finding N2).
 *
 * <p>It carries {@code Kure.SEARCH} only because the framework annotation processor requires every
 * test method to resolve a Küre tag ({@code KureNotFoundException} otherwise). {@code @EnabledIfSystemProperty("dump.url")}
 * disables it (before any browser starts) unless the kit passes {@code -Ddump.url}.
 *
 * <p>Dumps the RENDERED DOM (via {@link com.sahibinden.web.client.facility.PageFacility#getPageSource()})
 * so selector-break fixes can be authored from the real DOM — curl returns only a login/skeleton.
 */
@Tags({@Tag(MainTag.PARALLEL), @Tag(Kure.SEARCH)})
public class PageDomCaptureTest extends TestDataResource {

  @AutowiredBean
  private HomePage homePage;

  @Description("Hektor kit: dump rendered DOM of -Ddump.url to -Ddump.output (selector-fix authoring)")
  @ParameterizedWebTest
  @EnabledIfSystemProperty(named = "dump.url", matches = ".+")
  @MethodSource("dumpTarget")
  public void testDumpRenderedDom(String url) throws Exception {
    String html = homePage.go(url).waitForPageLoad().getPageSource();

    String out = System.getProperty("dump.output", "");
    if (!out.isBlank()) {
      Files.write(Path.of(out), html.getBytes(StandardCharsets.UTF_8));
      System.out.println("DOM-CAPTURE-OK chars=" + html.length() + " out=" + out);
    } else {
      System.out.println("DOM-CAPTURE-BEGIN");
      System.out.println(html);
      System.out.println("DOM-CAPTURE-END");
    }
  }

  static Stream<Arguments> dumpTarget() {
    return Stream.of(Arguments.of(System.getProperty("dump.url", "")));
  }
}
