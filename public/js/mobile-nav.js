// mobile-nav.js
document.addEventListener('DOMContentLoaded', () => {
  const nav = document.querySelector('nav');
  if (!nav) return;

  // Let's find the main links container and the secondary container (actions like Get Started / Sign Out)
  // Usually the structure is: <nav> <a>Brand</a> <div class="links">...</div> <div class="actions">...</div> </nav>
  // We want to extract ALL <a> and <button> tags that are direct children of div's inside nav, 
  // excluding the brand, and shove them into a mobile menu.

  // Let's create a hamburger button inside nav (usually absolute right or flex-end)
  const btn = document.createElement('button');
  btn.id = 'mobile-menu-btn';
  btn.className = 'md:hidden text-violet-300 hover:text-amber-300 p-2 z-[60] relative focus:outline-none ml-auto';
  btn.innerHTML = '<span class="material-symbols-outlined text-3xl transition-transform duration-300" id="hamburger-icon">menu</span>';
  
  // Try to append it to the end of the flex container that contains everything, or directly to nav
  // Many navs have a parent inner div `flex justify-between`
  let wrapRow = nav.querySelector('div.flex.justify-between');
  if (!wrapRow) wrapRow = nav;
  wrapRow.appendChild(btn);

  // Now create the mobile drawer
  const drawer = document.createElement('div');
  drawer.id = 'mobile-drawer';
  drawer.className = 'fixed top-0 left-0 w-full h-screen bg-[#0e0c1f]/95 backdrop-blur-2xl z-[70] flex flex-col items-center justify-center gap-8 transform transition-transform duration-500 translate-x-full md:hidden';
  
  // Add direct close button inside drawer
  const drawerCloseBtn = document.createElement('button');
  drawerCloseBtn.className = 'absolute top-6 right-6 text-violet-300 hover:text-amber-300 focus:outline-none p-2';
  drawerCloseBtn.innerHTML = '<span class="material-symbols-outlined text-4xl">close</span>';
  drawerCloseBtn.addEventListener('click', closeDrawer);
  drawer.appendChild(drawerCloseBtn);

  document.body.appendChild(drawer);

  // Grab all links and buttons from nav (excluding brand)
  const brandHref = '/';
  const navItems = Array.from(nav.querySelectorAll('a, button'))
     .filter(el => {
        if (el === btn) return false;
        if (el.innerText.includes('🌙') || el.classList.contains('font-headline')) return false; // brand
        return true;
     });

  navItems.forEach(item => {
    // We clone them so desktop nav remains untouched
    // BUT we need them to function (like sign out buttons, toggles).
    // The easiest way to keep event listeners is to clone text and HREF, and dispatch a click to the original on click
    const link = document.createElement('a');
    link.href = item.href || '#';
    link.innerHTML = item.innerHTML;
    link.className = 'text-violet-100 text-2xl font-headline italic hover:text-amber-300 transition-colors drop-shadow-md';
    
    // Original might be hidden by display:none inline style (like dashboard when logged out). We must reflect that.
    if (item.style.display === 'none') {
       link.style.display = 'none';
    }

    // sync visibility dynamically using MutationObserver
    const observer = new MutationObserver(() => {
       link.style.display = item.style.display;
    });
    observer.observe(item, { attributes: true, attributeFilter: ['style', 'class'] });

    link.addEventListener('click', (e) => {
      // close drawer
      closeDrawer();
      if (item.tagName === 'BUTTON' || (item.id && item.id.includes('logout'))) {
        e.preventDefault();
        item.click();
      }
    });

    drawer.appendChild(link);
  });

  const icon = btn.querySelector('#hamburger-icon');
  let open = false;

  function closeDrawer() {
    open = false;
    drawer.classList.remove('translate-x-0');
    drawer.classList.add('translate-x-full');
    icon.textContent = 'menu';
    icon.classList.remove('rotate-90');
    document.body.style.overflow = '';
  }

  btn.addEventListener('click', () => {
    open = !open;
    if (open) {
      drawer.classList.remove('translate-x-full');
      drawer.classList.add('translate-x-0');
      icon.textContent = 'close';
      icon.classList.add('rotate-90');
      document.body.style.overflow = 'hidden';
    } else {
      closeDrawer();
    }
  });
});
