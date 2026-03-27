# Design System Specification: The Academic Architect

## 1. Overview & Creative North Star
**Creative North Star: The Informed Curator**

Educational tools often fall into two traps: being overly clinical and dry, or appearing too "gamified" and juvenile. This design system rejects both. Our goal is **The Informed Curator**—a visual language that feels as authoritative as a prestige university publication but as fluid and responsive as a modern AI agent. 

We break the "template" look by abandoning the rigid 1px border. Instead, we define space through **Tonal Sculpting**. By using subtle shifts in surface values and intentional asymmetry in layout, we create a rhythmic, editorial flow that guides a student’s eye through complex information without the cognitive load of "box-heavy" interfaces. This is high-end minimalism: it isn't about what is missing, but about the intentionality of what remains.

---

## 2. Colors & Surface Architecture

The palette centers on a sophisticated interplay of `primary` (#3755C3) and deep `secondary` tones, balanced by an expansive range of neutrals that provide "breathing room" for dense educational content.

### The "No-Line" Rule
**Designers are strictly prohibited from using 1px solid borders for sectioning.** 
Structural boundaries must be defined solely through background color shifts. For example, a sidebar using `surface_container_low` should sit against a main content area of `surface`. This creates a seamless, "molded" look rather than a fragmented one.

### Surface Hierarchy & Nesting
Treat the UI as a series of physical layers. We use the Material surface tiers to create depth:
- **Level 0 (Base):** `surface` (#F7F9FB) – The primary canvas.
- **Level 1 (Subtle Inset):** `surface_container_low` (#F0F4F7) – Use for secondary sidebars or global navigation.
- **Level 2 (Elevated):** `surface_container_lowest` (#FFFFFF) – Reserved for high-priority interactive cards or "focused" reading zones.
- **Level 3 (Functional):** `surface_container_high` (#E1E9EE) – Use for muted utility panels or inactive states.

### The "Glass & Gradient" Rule
To add a signature "soul" to the AI experience:
- **AI Interactions:** Use `surface_container_lowest` with a 70% opacity and a `20px` backdrop-blur for floating AI chat modules.
- **High-Impact CTAs:** Use a subtle linear gradient (45°) from `primary` (#3755C3) to `primary_dim` (#2848B7) to create a sense of optical depth that flat colors cannot achieve.

---

## 3. Typography: Editorial Authority

We employ a dual-typeface system to distinguish between **Display (Manrope)** for personality and **Utility (Inter)** for focus.

- **The Display Scale (Manrope):** Large, assertive headers. `display-lg` (3.5rem) should be used with `on_surface` to introduce major learning modules. The wider apertures of Manrope feel modern and welcoming.
- **The Body Scale (Inter):** Highly legible and neutral. Use `body-lg` (1rem) for primary lesson text with a line-height of 1.6 to ensure readability for neurodivergent learners.
- **Hierarchy of Focus:** Use `on_surface_variant` (#566166) for `label-md` metadata to ensure the primary lesson content (`on_surface`) always maintains the highest visual dominance.

---

## 4. Elevation & Depth: Tonal Layering

Traditional drop shadows are often a crutch for poor layout. In this system, depth is achieved through **Tonal Layering**.

- **The Layering Principle:** Place a `surface_container_lowest` card on a `surface_container_low` background. This creates a "soft lift" that feels architectural rather than "pasted on."
- **Ambient Shadows:** Only use shadows for floating elements (e.g., Popovers, Tooltips). Use a diffuse 16px blur with `on_surface` at 6% opacity. This mimics natural ambient light.
- **The Ghost Border Fallback:** If a divider is mandatory for accessibility (e.g., in a high-density table), use `outline_variant` (#A9B4B9) at **15% opacity**. A 100% opaque border is considered a design failure.

---

## 5. Components

### Buttons
- **Primary:** Gradient-filled (`primary` to `primary_dim`), `md` (0.75rem) rounded corners. Text: `on_primary`.
- **Secondary:** `surface_container_high` background with `on_secondary_container` text. No border.
- **Tertiary/Ghost:** No background. Use `on_primary_fixed` text for high-contrast visibility.

### Cards (The "Learning Unit")
- **Layout:** Cards must never have borders. Use `surface_container_lowest` and an `lg` (1rem) corner radius.
- **Spacing:** Minimum `6` (1.5rem) internal padding.
- **Interactivity:** On hover, shift the background to `primary_container` (#DDE1FF) and transition the shadow to 8% opacity.

### Input Fields
- **Base:** `surface_container_low` background with a `sm` (0.25rem) bottom-only "active line" using `primary`.
- **States:** Error states use `error` (#9F403D) for the line and helper text. The input background should remain neutral to prevent visual vibration.

### AI Thought-Stream (Custom Component)
- A specialized vertical list for AI reasoning. Use `2` (0.5rem) spacing between items. Each item is a `surface_container_lowest` chip with a `primary_fixed` left-accent bar (4px width).

---

## 6. Do’s and Don’ts

### Do:
- **Use "Macro-Spacing":** Use `12` (3rem) or `16` (4rem) spacing between major educational sections to reduce "choice paralysis."
- **Nesting Surfaces:** Place "active" content on the "lightest" surface (lowest value) to make it pop forward.
- **Asymmetric Balance:** Align headers to the far left while placing supportive imagery or AI suggestions slightly offset to the right.

### Don’t:
- **Don't use Dividers:** Never use a horizontal line to separate list items. Use `2` (0.5rem) of vertical white space or a slight hover-state background shift instead.
- **Don't use Pure Black:** Always use `on_surface` (#2A3439) for text. Pure black (#000000) creates eye strain on crisp white backgrounds.
- **Don't Over-round:** Stick to the `md` (0.75rem) radius for cards. `full` (pill) shapes are reserved exclusively for Chips and primary Buttons.