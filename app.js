  /* ============ Storage shim ============ */
  // window.storage is provided automatically inside Claude.ai artifacts.
  // Running this file standalone (e.g. opened directly, or hosted elsewhere)?
  // Fall back to localStorage so the app still works outside that sandbox.
  if (!window.storage) {
    window.storage = {
      async get(key, shared) {
        const raw = localStorage.getItem((shared ? 'shared:' : 'private:') + key);
        if (raw === null) throw new Error('not found');
        return { key, value: raw, shared: !!shared };
      },
      async set(key, value, shared) {
        localStorage.setItem((shared ? 'shared:' : 'private:') + key, value);
        return { key, value, shared: !!shared };
      },
      async delete(key, shared) {
        localStorage.removeItem((shared ? 'shared:' : 'private:') + key);
        return { key, deleted: true, shared: !!shared };
      },
      async list(prefix, shared) {
        const p = (shared ? 'shared:' : 'private:') + (prefix || '');
        const keys = Object.keys(localStorage).filter(k => k.startsWith(p)).map(k => k.slice((shared ? 'shared:' : 'private:').length));
        return { keys, prefix, shared: !!shared };
      }
    };
  }

  /* ============ State ============ */
  let places = [];
  let packages = [];           // [{id, name, cost}] — shared prices covering multiple stops
  let trips = [];              // [{id, name, shared}]
  let currentTripId = null;

  let currentFilter = 'all';
  let currentView = 'grid';
  let editingId = null;
  let confirmingDeleteId = null;
  let draggedId = null;
  let dragOverEl = null;
  let dragStartSnapshot = null; // places order when the drag began, for cancel/undo
  let dropHappened = false;     // did a drop actually complete this drag?
  let isLoading = true;
  let lastFocusId = null;
  let undoSnapshot = null;
  let undoPackagesSnapshot = null; // only set when an action also changes packages[]

  const viewContainer = document.getElementById('viewContainer');
  const TRIPS_INDEX_KEY = 'trips-index';
  const UNSCHEDULED_KEY = 'Unscheduled'; // group key used for stops with no "day" set

  const SAMPLE_PLACES = [
  {
    "id": "s2",
    "name": "Statue of Liberty",
    "category": "sightseeing",
    "day": "",
    "address": "Liberty Island, New York, NY 10004",
    "desc": "• Book a \"Reserve\" ticket to skip lines and arrive 45-60 minutes early for mandatory security.\n\n• Stand on the starboard (right) side of the ferry for the best views and photo angles on the approach.\n\n• Budget 4-5 hours for the full tour; bring quarters for lockers as large daypacks aren't allowed inside.",
    "image": "images/1.jpg",
    "cost": null,
    "packageId": "pkg-1788129485954n4a8xunrpce",
    "lat": 40.6898508,
    "lng": -74.0476674,
    "website": "https://statuecitycruises.com/"
  },
  {
    "id": "s3",
    "name": "New York Crown",
    "category": "sightseeing",
    "day": "",
    "address": "Liberty Island, New York, NY 10004",
    "desc": "• Book \"Crown Reserve\" tickets months in advance; you must bring a matching photo ID to Castle Clinton to get mandatory wristbands.\n\n• Wear closed-toe shoes for the strenuous, tight climb up 162 narrow spiral steps (there is no elevator beyond the pedestal).\n\n• Strict security allows only cameras, phones, water, and meds. Bring quarters for mandatory lockers to store all bags.",
    "image": "images/2.jpg",
    "cost": 0.3,
    "packageId": null,
    "lat": 40.6898508,
    "lng": -74.0476674,
    "website": "https://statuecitycruises.com/"
  },
  {
    "id": "1788127853367",
    "name": "Ellis Island National Museum of Immigration",
    "category": "museums-culture",
    "day": "",
    "address": "Ellis Island, New York, NY 10004",
    "desc": "• Pick up the self-guided audio tour headset right at the entrance, as it is fully included with your standard ferry ticket.\n\n• Budget 2-3 hours to explore the main exhibits and Great Hall, or book an additional 90-minute \"Hard Hat Tour\" of the unrestored hospital grounds.\n\n• The museum begins closing 30 minutes before the final ferry departs; track the seasonal boat schedule closely to avoid missing your return trip.",
    "image": "images/3.jpg",
    "cost": null,
    "packageId": "pkg-1788129485954n4a8xunrpce",
    "lat": 40.7035183,
    "lng": -74.0169254,
    "website": "https://statuecitycruises.com/"
  },
  {
    "id": "s1",
    "name": "Empire State Building Observatory",
    "category": "skyscrapers",
    "day": "",
    "address": "20 W 34th St., New York, NY 10001",
    "desc": "• Budget 1.5 to 2 hours for the visit, and book tickets well in advance if you want the highly popular sunset time slot.\n\n• Standard admission provides access to the open-air 86th floor, while the smaller 102nd-floor enclosed deck requires a pricier ticket upgrade.\n\n• All visitors must pass mandatory security screenings; large bags, glass items, and camera tripods are strictly prohibited.",
    "image": "images/4.jpg",
    "cost": 44,
    "packageId": null,
    "lat": 40.7486538,
    "lng": -73.9853043,
    "website": "https://www.esbnyc.com/"
  },
  {
    "id": "1788179669671",
    "name": "Times Square",
    "category": "outdoors",
    "day": "",
    "address": "Manhattan, NY 10036",
    "desc": "• Visit late in the evening when the giant digital billboards are brightest and the peak daytime crowds have slightly thinned out.\n\n• Avoid interacting with costumed characters or accepting \"free\" CDs from street vendors unless you are prepared to hand over a cash tip.\n\n• Head to the red glass steps at the TKTS booth in Duffy Square if you want to check for same-day discounted Broadway show tickets.",
    "image": "images/5.jpg",
    "cost": 0,
    "packageId": null,
    "lat": 40.7579554,
    "lng": -73.9855319,
    "website": "https://www.timessquarenyc.org"
  },
  {
    "id": "1788195131854",
    "name": "Brooklyn Bridge",
    "category": "outdoors",
    "day": "",
    "address": "New York, NY 10038",
    "desc": "• Start the walk on the Brooklyn side heading toward Manhattan so the iconic city skyline is always directly in front of you.\n\n• Budget 45 to 60 minutes for the crossing; there is absolutely no shade on the bridge, so bring water and sun protection on clear days.\n\n• Cross early in the morning or late in the evening to avoid the massive midday tourist crowds and bottlenecks on the pedestrian walkway.",
    "image": "images/6.jpg",
    "cost": 0,
    "packageId": null,
    "lat": 40.7127281,
    "lng": -74.0060152,
    "website": "https://www.nyc.gov/html/dot/html/infrastructure/brooklyn-bridge.shtml"
  },
  {
    "id": "1788196267169",
    "name": "Grand Central Terminal",
    "category": "sightseeing",
    "day": "",
    "address": "89 E 42nd St, New York, NY 10017",
    "desc": "• View the famous celestial ceiling in the Main Concourse, but stand near the edges to avoid blocking the fast-moving paths of local commuters.\n\n• Test the acoustics at the Whispering Gallery located just outside the lower-level Oyster Bar by having two people whisper into opposite diagonal corners.\n\n• Utilize the lower-level Dining Concourse as a highly convenient pit stop for clean public restrooms and a wide variety of quick food options.",
    "image": "images/7.jpg",
    "cost": 0,
    "packageId": null,
    "lat": 40.7528064,
    "lng": -73.9771792,
    "website": ""
  },
  {
    "id": "1788197283793",
    "name": "Central Park",
    "category": "outdoors",
    "day": "",
    "address": "72 Terrace Dr, New York, NY 10021",
    "desc": "• The park is massive (843 acres); do not attempt to walk the whole thing in one day, but rather focus on a specific section like the southern loop for iconic spots like Bethesda Terrace and Bow Bridge.\n\n• If you get turned around, check the cast-iron lampposts lining the paths; the first two or three digits on the metal plaque indicate the closest cross street.\n\n• Stick to the designated pedestrian paths and look both ways before crossing the main loop roads, as they are heavily trafficked by fast-moving cyclists and pedicabs.",
    "image": "images/8.jpg",
    "cost": 0,
    "packageId": null,
    "lat": 40.9972433,
    "lng": -73.8745241,
    "website": "https://www.centralparknyc.org"
  },
  {
    "id": "1788197581955",
    "name": "The High Line",
    "category": "outdoors",
    "day": "",
    "address": "820 Washington St, New York, NY 10014",
    "desc": "• Start at the southern entrance (Gansevoort Street) and walk north; this route allows you to easily grab lunch at Chelsea Market and end your walk right at Hudson Yards.\n\n• Walk the path on a weekday morning to avoid severe pedestrian bottlenecks, as the narrow, elevated walkway gets heavily congested on weekends.\n\n• Not all street-level access points have elevators; if you want to avoid stairs, check the official map in advance so you don't get stuck walking further than intended.",
    "image": "images/9.jpg",
    "cost": 0,
    "packageId": null,
    "lat": 40.7397293,
    "lng": -74.0082119,
    "website": "https://www.thehighline.org"
  },
  {
    "id": "1788197817249",
    "name": "Little Island",
    "category": "outdoors",
    "day": "",
    "address": "Pier 55 at Hudson River Park, New York, NY 10014",
    "desc": "• Combine this stop with The High Line, as the southern entrance on Gansevoort Street is just a short 5-minute walk away from the pier.\n\n• General admission is completely free, and timed-entry reservations are no longer required to enter the park at any time.\n\n• Follow the paved pathways up to the main amphitheater (The Amph) to access the highest elevation points for clear, unobstructed views of the downtown skyline.",
    "image": "images/10.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://littleisland.org"
  },
  {
    "id": "1788199698262",
    "name": "The Metropolitan Museum of Art (The Met)",
    "category": "museums-culture",
    "day": "",
    "address": "1000 5th Ave, New York, NY 10028",
    "desc": "• Do not attempt to see the massive collection in a single visit; pick two or three specific wings to focus on to avoid museum fatigue.\n\n• Schedule your visit around the museum's strict Wednesday closures; if you want to avoid daytime crowds, aim for Friday or Saturday when doors stay open until 9:00 PM.\n\n• Bypass the crowded main steps by using the ground-level entrance located at 81st Street, which typically has much shorter security and ticketing lines.",
    "image": "images/11.jpg",
    "cost": 30,
    "packageId": null,
    "lat": 40.7794396,
    "lng": -73.9633825,
    "website": "https://www.metmuseum.org"
  },
  {
    "id": "1788207781358",
    "name": "The Museum of Modern Art (MoMA)",
    "category": "museums-culture",
    "day": "",
    "address": "11 W 53rd St, New York, NY 10019",
    "desc": "• Take the elevator straight to the 5th floor when you arrive to view the most famous pieces, like \"The Starry Night,\" before working your way down through the less crowded galleries.\n\n• Avoid visiting on Friday evenings from 5:30 PM to 8:30 PM if you want to dodge heavy crowds, as this time block offers free admission to New York residents.\n\n• Travel light, as all bags larger than 11×17×5 inches, including rolling luggage and skateboards, are strictly prohibited and cannot be checked at the coatroom.",
    "image": "images/12.jpg",
    "cost": 30,
    "packageId": null,
    "lat": 40.7616124,
    "lng": -73.9774992,
    "website": "https://www.moma.org"
  },
  {
    "id": "1788208427264",
    "name": "9/11 Memorial & Museum",
    "category": "museums-culture",
    "day": "",
    "address": "180 Greenwich St, New York, NY 10007",
    "desc": "• The outdoor memorial pools are free and accessible to the public daily, but the underground museum requires a paid, timed-entry ticket and is closed on Tuesdays.\n\n• Budget 2 to 3 hours for the museum; you must pass through mandatory airport-style security, so aim to arrive 15 minutes before your ticketed time slot.\n\n• Download the official audio guide app to your phone before heading down to the main exhibits, as cellular network service is virtually nonexistent underground.",
    "image": "images/13.jpg",
    "cost": 33,
    "packageId": null,
    "lat": 40.7113675,
    "lng": -74.0132704,
    "website": "https://www.911memorial.org"
  },
  {
    "id": "1788209020575",
    "name": "Edge NYC Observatory",
    "category": "skyscrapers",
    "day": "",
    "address": "30 Hudson Yards, New York, NY 10001",
    "desc": "• Access the entrance on Level 4 inside The Shops at Hudson Yards, which allows you to easily pair this visit with the northern trailhead of The High Line just outside.\n\n• Book tickets several weeks in advance if you want a highly sought-after sunset time slot, and expect to pay an upcharge for those specific peak hours.\n\n• The outdoor viewing area features a completely see-through glass floor and angled glass walls; avoid wearing skirts or dresses if you plan to walk on the glass due to the reflective surfaces below.",
    "image": "images/14.jpg",
    "cost": 39,
    "packageId": null,
    "lat": 40.753983,
    "lng": -74.0006028,
    "website": "https://www.edgenyc.com"
  },
  {
    "id": "1788209444903",
    "name": "One World Observatory",
    "category": "skyscrapers",
    "day": "",
    "address": "117 West St, New York, NY 10007",
    "desc": "• Locate the main visitor entrance on West Street, as it is completely separate from the 9/11 Memorial pools and the Oculus transit hub.\n\n• This is the only major NYC observation deck that is entirely enclosed indoors, making it the most reliable choice for rainy, windy, or extremely cold days.\n\n• To reduce heavy glare and reflections from the thick double-paned windows, press your phone or camera lens directly flat against the glass when taking pictures.",
    "image": "images/15.jpg",
    "cost": 44,
    "packageId": null,
    "lat": 40.7138389,
    "lng": -74.0135131,
    "website": "https://www.oneworldobservatory.com"
  },
  {
    "id": "1788209854164",
    "name": "Top of the Rock Observatory",
    "category": "skyscrapers",
    "day": "",
    "address": "30 Rockefeller Plaza, New York, NY 10112",
    "desc": "• Locate the main visitor entrance on 50th Street between 5th and 6th Avenues to save time, rather than wandering through the main Rockefeller Center concourse.\n\n• Head all the way up to the uppermost tier on the 70th floor to enjoy completely unobstructed, open-air views without any glass panels or wire fencing.\n\n• This observatory is widely considered the best option for classic skyline views because it offers a perfectly centered, dead-on look at the Empire State Building to the south and Central Park to the north.",
    "image": "images/16.jpg",
    "cost": 43,
    "packageId": null,
    "lat": 40.7591232,
    "lng": -73.979556,
    "website": "https://www.topoftherocknyc.com"
  },
  {
    "id": "1788210119109",
    "name": "American Museum of Natural History",
    "category": "museums-culture",
    "day": "",
    "address": "200 Central Park West, New York, NY 10024",
    "desc": "• General admission requires booking a timed-entry ticket online in advance; special exhibits like the Hayden Planetarium or the Butterfly Vivarium require pricier upgraded tickets.\n\n• Avoid the heavy bottlenecks at the main Central Park West entrance by using the lower-level subway entrance on 81st Street or the new Gilder Center doors on Columbus Avenue.\n\n• Download the free AMNH Explorer app before you arrive to access an interactive, blue-dot navigation map, as the massive, multi-building layout is notoriously easy to get lost in.",
    "image": "images/17.jpg",
    "cost": 28,
    "packageId": null,
    "lat": 40.7811007,
    "lng": -73.9742362,
    "website": "https://www.amnh.org"
  },
  {
    "id": "1788210434835",
    "name": "Intrepid Museum",
    "category": "museums-culture",
    "day": "",
    "address": "Pier 86, W 46th St, New York, NY 10036",
    "desc": "• The museum is located on the Hudson River; wear layers and prepare for the elements, as the outdoor flight deck is highly exposed to strong winds and direct sun.\n\n• Touring the Growler submarine requires navigating extremely tight spaces and passing through a small hatch model beforehand; all large bags must be left in the provided bins before entering.\n\n• The nearest subway stations are a very long walk (roughly 15 to 20 minutes) from the pier, so consider taking a crosstown bus (like the M42 or M50) directly to 12th Avenue to save your feet.",
    "image": "images/18.jpg",
    "cost": 36,
    "packageId": null,
    "website": "https://intrepidmuseum.org"
  },
  {
    "id": "1788210762631",
    "name": "Vessel",
    "category": "outdoors",
    "day": "",
    "address": "20 Hudson Yards, New York, NY 10001",
    "desc": "• General admission requires a paid, timed-entry ticket booked in advance, though New York City residents can visit for free on Thursdays by presenting a valid local ID.\n\n• Budget 30 to 45 minutes to climb the honeycomb-like structure; steel safety netting is now installed on the upper platforms, but the gaps are wide enough to take clear, unobstructed photos.\n\n• An elevator is available for those who need it, and the 154 interconnected flights of stairs are broken into short, manageable sections allowing you to rest on any landing or turn back at any time.",
    "image": "images/19.jpg",
    "cost": 14,
    "packageId": null,
    "lat": 40.7559064,
    "lng": -74.0005322,
    "website": "https://www.hudsonyardsnewyork.com/discover/vessel"
  },
  {
    "id": "1788211021015",
    "name": "St. Patrick's Cathedral",
    "category": "sightseeing",
    "day": "",
    "address": "5th Ave, New York, NY 10022",
    "desc": "• The cathedral is completely free to enter, but as an active place of worship, check the daily schedule online to avoid arriving during a Mass or private event.\n\n• Security guards perform brief bag checks at the main 5th Avenue entrances; travel light to keep the line moving, as large luggage and backpacks are not permitted.\n\n• Budget 15 to 20 minutes for a self-guided walk-through to see the massive organ and stained glass, and skip the paid audio tour unless you want deep architectural details.",
    "image": "images/20.jpg",
    "cost": 0,
    "packageId": null,
    "lat": 40.7622941,
    "lng": -73.974469,
    "website": "https://saintpatrickscathedral.org"
  },
  {
    "id": "1788295416885",
    "name": "Madame Tussauds New York",
    "category": "sightseeing",
    "day": "",
    "address": "234 W 42nd St, New York, NY 10036",
    "desc": "• Purchase your tickets online in advance to bypass the notoriously long walk-up lines that form along the crowded 42nd Street sidewalk.\n\n• Budget 1.5 to 2 hours for the self-guided walkthrough; there are no ropes or glass barriers, so you can step right up to the figures for interactive photos.\n\n• Travel light and avoid bringing large bags, as they are subject to mandatory security searches at the entrance and the museum does not offer coat or luggage checks.",
    "image": "images/21.jpg",
    "cost": 44,
    "packageId": null,
    "lat": 40.7562126,
    "lng": -73.988438,
    "website": "https://www.madametussauds.com/new-york"
  },
  {
    "id": "1788295918065",
    "name": "Mercer Labs – Museum of Art and Technology",
    "category": "museums-culture",
    "day": "",
    "address": "21 Dey St, New York, NY 10007",
    "desc": "• Budget 1.5 to 2 hours. Be prepared for immersive, multi-sensory rooms with intense lighting and audio.\n\n• Located one block east of the Oculus; pairs perfectly with the World Trade Center.\n\n• Travel light. Oversized bags are strictly prohibited and there is no luggage check available.",
    "image": "images/22.jpg",
    "cost": 52,
    "packageId": null,
    "lat": 40.710759,
    "lng": -74.010453,
    "website": "https://www.mercerlabs.com"
  },
  {
    "id": "1788297048914",
    "name": "Circle Line NYC Landmarks Cruise",
    "category": "sightseeing",
    "day": "",
    "address": "Pier 83, W 42nd St, New York, NY 10036",
    "desc": "See times on website\n\n\n• Arrive 45 minutes before departure to pass through security and secure a prime outdoor seat.\n\n• Sit on the left (port) side of the boat for the absolute best, unobstructed views of the Statue of Liberty.\n\n• Bring a light jacket or windbreaker even on warm days, as the breeze on the open water is surprisingly cold.",
    "image": "images/23.jpg",
    "cost": 41,
    "packageId": null,
    "lat": 40.7627646,
    "lng": -74.0015078,
    "website": "https://www.circleline.com"
  },
  {
    "id": "1788461113442",
    "name": "Museum of Broadway",
    "category": "museums-culture",
    "day": "",
    "address": "145 W 45th St, New York, NY 10036",
    "desc": "• Budget 1.5 to 2 hours for this highly interactive, self-guided walkthrough of theater history.\n\n• Located right off Times Square; ideal to schedule just before catching an afternoon matinee.\n\n• Make sure your phone is fully charged. The immersive exhibit rooms are designed with numerous photo ops.",
    "image": "images/24.jpg",
    "cost": 44,
    "packageId": null,
    "website": "https://www.themuseumofbroadway.com"
  },
  {
    "id": "1788463783002",
    "name": "RiseNY",
    "category": "entertainment-nightlife",
    "day": "",
    "address": "160 W 45th St, New York, NY 10036",
    "desc": "• Budget 1 to 1.5 hours. The experience is broken into two parts: walking through museum galleries detailing NYC's pop culture history, culminating in a 4D flying theater ride.\n\n• The flying theater suspends you 30 feet in the air with your feet dangling. If you suffer from severe motion sickness or a fear of heights, you can notify staff to walk through and skip the ride portion.\n\n• Located mere steps from Times Square, this is an excellent indoor backup activity to escape extreme heat or sudden rain while waiting for a Broadway matinee.",
    "image": "images/25.jpg",
    "cost": 35,
    "packageId": null,
    "website": "https://www.riseny.com"
  },
  {
    "id": "1788464505629",
    "name": "Rockefeller Center",
    "category": "sightseeing",
    "day": "",
    "address": "45 Rockefeller Plaza, New York, NY 10111",
    "desc": "• Budget 45 to 60 minutes just to walk around the main plaza, see the flags, the Prometheus statue, and the Channel Gardens.\n\n• The iconic ice skating rink and massive Christmas tree are only present in the winter; during the warmer months, the sunken plaza transforms into a roller rink or outdoor dining space.\n\n• The complex is massive and contains Radio City Music Hall, NBC Studios, and the entrance to Top of the Rock. Check signs carefully to find the specific entrances for any ticketed tours.",
    "image": "images/26.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.rockefellercenter.com"
  },
  {
    "id": "1788464770925",
    "name": "Luna Park at Coney Island",
    "category": "entertainment-nightlife",
    "day": "",
    "address": "1000 Surf Ave, Brooklyn, NY 11224",
    "desc": "• Budget 3 to 4 hours. The park itself is free to enter and walk around; you only pay for the rides, which can be done via an unlimited wristband or individual pay-per-ride credits.\n\n• This is a highly seasonal attraction. It operates daily throughout the summer, drops to weekend-only hours in the spring and fall, and is completely closed during the winter months.\n\n• If you plan to ride the legendary Coney Island Cyclone wooden roller coaster, verify if it is included in your specific wristband tier for the day, as policies occasionally shift.",
    "image": "images/27.jpg",
    "cost": 65,
    "packageId": null,
    "website": "https://lunaparknyc.com"
  },
  {
    "id": "1788466050759",
    "name": "SPYSCAPE",
    "category": "museums-culture",
    "day": "",
    "address": "928 8th Ave, New York, NY 10019",
    "desc": "• Budget 1.5 to 2 hours for the main museum experience. Upon entry, you receive an RFID wristband that tracks your performance through interactive challenges—like laser mazes and code-breaking—to build a personalized \"spy profile\".\n\n• The venue offers two distinct attractions: the core SPYSCAPE museum (focused on history, brain-teasing puzzles, and psychology) and SPYGAMES (a highly physical, agility-based obstacle experience). Make sure you know which one you are booking, or upgrade to an all-access pass.\n\n• The museum was designed by Sir David Adjaye and features authentic espionage artifacts, including an Enigma machine replica and high-tech lie-detection equipment.",
    "image": "images/28.jpg",
    "cost": 39,
    "packageId": null,
    "website": "https://spyscape.com"
  },
  {
    "id": "1788466922365",
    "name": "Radio City Music Hall",
    "category": "entertainment-nightlife",
    "day": "",
    "address": "1260 6th Avenue, New York, NY 10020",
    "desc": "• Budget about 60 minutes for the Radio City Music Hall Tour Experience, which takes you through the Grand Foyer and the Great Stage.\n\n• The guided tours run on a first-come, first-served basis, but access to certain areas may vary depending on the venue's live event schedule.\n\n• If you plan to take the tour, keep in mind that large bags and backpacks are not permitted inside.",
    "image": "images/29.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.msg.com/radio-city-music-hall"
  },
  {
    "id": "1788467215986",
    "name": "DUMBO",
    "category": "viewpoints-photography",
    "day": "",
    "address": "Washington St & Water St, Brooklyn, NY 11201",
    "desc": "• Budget 1.5 to 2 hours to explore the neighborhood, grab a bite at Time Out Market, and walk along the waterfront at Brooklyn Bridge Park.\n\n• The iconic, heavily photographed view framing the Manhattan Bridge (with the Empire State Building visible through the arches) is specifically located at the intersection of Washington Street and Water Street.\n\n• Because it is one of the most popular photo spots in the city, the street gets incredibly crowded by midday. Arrive early in the morning for clear shots, and wear comfortable shoes to navigate the uneven cobblestone streets.",
    "image": "images/30.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://dumbo.is"
  },
  {
    "id": "1788467514276",
    "name": "Carnegie Hall",
    "category": "entertainment-nightlife",
    "day": "",
    "address": "881 7th Ave, New York, NY 10019",
    "desc": "• Budget about 60 to 90 minutes if you are taking a guided tour, or 2 to 3 hours if you are attending a live performance. \n\n• Guided tours are typically offered from October through June, but because this is a highly active venue, tours are frequently canceled or modified at the last minute due to rehearsals. Always confirm availability online before walking up.\n\n• The Rose Museum, located on the second floor, is free to the public and features archival materials, programs, and historical artifacts from the hall's legendary history.",
    "image": "images/31.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.carnegiehall.org"
  },
  {
    "id": "1788468090767",
    "name": "SEA LIFE Aquarium New Jersey",
    "category": "sightseeing",
    "day": "",
    "address": "American Dream, 1 American Dream Way, Suite A, East Rutherford, NJ 07073",
    "desc": "• Budget 1.5 to 2 hours. The entire aquarium is uniquely themed as a \"City Under the Sea,\" featuring underwater replicas of famous New York City landmarks.\n\n• Keep in mind this is located in New Jersey inside the massive American Dream entertainment and retail complex. You will need to factor in about 30 to 45 minutes of travel time from Manhattan (the NJ Transit Bus 111 from Port Authority is usually the most direct public route).\n\n• If you plan to visit the adjacent LEGOLAND Discovery Center, check their website for combo tickets, which often save you a significant amount compared to buying them separately.",
    "image": "images/32.jpg",
    "cost": 31,
    "packageId": null,
    "website": "https://www.visitsealife.com/new-jersey/"
  },
  {
    "id": "1788468580495",
    "name": "Little Italy",
    "category": "sightseeing",
    "day": "",
    "address": "151 Mulberry St, New York, NY 10013",
    "desc": "• Budget 45 to 60 minutes to stroll the historic blocks of Mulberry and Grand Streets, taking in the neighborhood's loud personality.\n\n• Use 151 Mulberry Street as your primary waypoint; this is the location of the Italian American Museum, which explores the history, culture, and contributions of Italian Americans.\n\n• If you visit during September, the neighborhood transforms for the annual Feast of San Gennaro, a street festival taking over Mulberry Street with music, religious processions, and crowds.",
    "image": "images/33.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://littleitalynyc.com"
  },
  {
    "id": "1788468814209",
    "name": "Chinatown",
    "category": "sightseeing",
    "day": "",
    "address": "67 Mulberry St, New York, NY 10013",
    "desc": "• Budget 1 to 2 hours to walk the busy streets, explore the historic architecture, and photograph the famously curved Doyers Street.\n\n• Use Columbus Park at 67 Mulberry Street as your primary waypoint. It is the largest park in the neighborhood and serves as a major outdoor community gathering space.\n\n• For a piece of local history, walk down to Chatham Square to see the Kimlau War Memorial. The arch was erected in 1961 and honors Americans of Chinese ancestry who lost their lives defending freedom and democracy.",
    "image": "images/34.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.nyctourism.com/new-york/manhattan/chinatown"
  },
  {
    "id": "1788469643088",
    "name": "Summit One Vanderbilt",
    "category": "skyscrapers",
    "day": "",
    "address": "45 E 42nd St, New York, NY 10017",
    "desc": "• Budget 1.5 to 2 hours. Because the space is completely covered in mirrors and transparent glass floors, you are highly encouraged to wear pants or shorts (avoid skirts or dresses) and bring sunglasses to handle the intense daytime glare.\n\n• Bring your Sony α6600 to capture the incredible reflective rooms and skyline views, but be aware of their strict equipment policy: tripods and large telephoto setups like your 100-400mm lens are not permitted inside. \n\n• Stiletto heels, cleats, and steel-toe boots are strictly banned as they can damage the glass flooring, so make sure to wear comfortable, flat-soled shoes.",
    "image": "images/35.jpg",
    "cost": 43,
    "packageId": null,
    "website": "https://summitov.com"
  },
  {
    "id": "1788470015231",
    "name": "Oculus Plaza",
    "category": "sightseeing",
    "day": "",
    "address": "185 Greenwich St, New York, NY 10007",
    "desc": "• Budget 30 to 45 minutes to walk around the exterior plaza and step inside to view the massive, ribbed white architecture of the main concourse.\n\n• The outdoor Oculus Plaza often hosts seasonal events, such as farmers markets, food festivals, or holiday villages, depending on the time of year you visit.\n\n• The structure functions as both a major transit hub and a high-end shopping mall (Westfield World Trade Center). While the main floor is open 24/7 for commuters, the individual stores and public restrooms follow standard mall hours.",
    "image": "images/36.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.officialworldtradecenter.com"
  },
  {
    "id": "1788470186066",
    "name": "Charging bull statue",
    "category": "sightseeing",
    "day": "",
    "address": "Broadway & Morris St, New York, NY 10004",
    "desc": "• Budget 15 to 30 minutes to view and photograph the 7,100-pound bronze statue created by artist Arturo Di Modica.\n\n• The statue is situated in a cobblestone-paved traffic median on Broadway, just north of Bowling Green. \n\n• Because it draws thousands of people a day, it is highly recommended to arrive early in the morning for the best chance at a clear photo without large crowds surrounding it.",
    "image": "images/37.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://arturodimodica.com"
  },
  {
    "id": "1788470430144",
    "name": "The Morgan Library and Museum",
    "category": "sightseeing",
    "day": "",
    "address": "225 Madison Ave, New York, NY 10016",
    "desc": "• Budget about 1 to 2 hours to explore this compact museum without rushing.\n\n• Standard adult admission is $25. However, the museum offers free entry on Fridays from 5:00 PM to 8:00 PM (advance reservation required), and the historic library rooms are free to visit on Tuesdays and Sundays from 3:00 PM to 5:00 PM.\n\n• Originally the private library of financier J. Pierpont Morgan, the venue features an extraordinary collection of rare manuscripts, books, and historical documents.",
    "image": "images/38.jpg",
    "cost": 25,
    "packageId": null,
    "website": "https://www.themorgan.org"
  },
  {
    "id": "1788470549533",
    "name": "New York Public Library",
    "category": "museums-culture",
    "day": "",
    "address": "225 Madison Ave, New York, NY 10016",
    "desc": "• Budget 1 to 1.5 hours to explore the stunning Beaux-Arts architecture and view the permanent historical exhibits.\n\n• This is the official home of the original stuffed Winnie the Pooh and pals (Eeyore, Piglet, Kanga, and Tigger) that belonged to Christopher Robin and inspired A.A. Milne's classic stories. They can be seen on permanent, free display inside the Polonsky Exhibition of The New York Public Library's Treasures on the main floor.\n\n• Be sure to head upstairs to photograph the breathtaking Rose Main Reading Room. Just remember to be completely silent and respectful of the space, as it remains an active research library for New Yorkers.",
    "image": "images/39.jpg",
    "cost": 25,
    "packageId": null,
    "website": "https://www.themorgan.org"
  },
  {
    "id": "1788470776017",
    "name": "Flatiron Building",
    "category": "viewpoints-photography",
    "day": "",
    "address": "175 5th Ave, New York, NY 10010",
    "desc": "• Budget 15 to 30 minutes to view and photograph the iconic triangular exterior from the pedestrian plazas near Madison Square Park.\n\n• The building is currently undergoing a massive multi-year interior conversion from office space into ultra-luxury residential condominiums, meaning you cannot go inside.\n\n• Scaffolding and black netting covered the famous landmark for roughly seven years, but as of early 2026, the exterior has finally begun to be fully revealed again as restoration wraps up.",
    "image": "images/40.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://flatironnomad.nyc"
  },
  {
    "id": "1788470934968",
    "name": "Washington Square Park",
    "category": "outdoors",
    "day": "",
    "address": "Washington Square, New York, NY 10012",
    "desc": "• Budget 45 to 60 minutes to walk around the central fountain, listen to the ever-present street musicians, and watch the legendary chess hustlers in the southwest corner.\n\n• The iconic Washington Square Arch sits at the northern boundary; if you position yourself correctly along the central path, you can perfectly frame the distant Empire State Building within the archway for a classic shot on your Sony α6600.\n\n• The park acts as an unofficial campus quad for the surrounding New York University (NYU), meaning it is constantly bustling with a highly energetic, bohemian, and sometimes chaotic atmosphere.",
    "image": "images/41.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.nycgovparks.org/parks/washington-square-park"
  },
  {
    "id": "1788471146363",
    "name": "Chelsea Market",
    "category": "shopping",
    "day": "",
    "address": "75 9th Ave, New York, NY 10011",
    "desc": "• Budget 1 to 1.5 hours to wander the historic, industrial-chic concourse of this former Nabisco factory complex, famous as the site where the Oreo cookie was invented.\n\n• The market hosts a variety of independent artisans, specialty grocery purveyors, and boutique retail merchants, including a sprawling artists and flea market located near the 10th Avenue exit.\n\n• Because the internal corridors are quite narrow, it is highly recommended to visit early in the morning or mid-afternoon to avoid the massive crowds that flood the complex during peak midday hours.",
    "image": "images/42.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.chelseamarket.com"
  },
  {
    "id": "1788471449030",
    "name": "Broadway Shows",
    "category": "entertainment-nightlife",
    "day": "",
    "address": "Broadway & W 47th St, New York, NY 10036",
    "desc": "• Budget roughly 2.5 to 3 hours for a standard Broadway musical, which usually includes a 15-minute intermission. \n\n• If you are flexible on what you want to see, use the TKTS booth—located directly under the iconic red glass steps in Father Duffy Square—to score same-day tickets for 20% to 50% off regular prices.\n\n• Pay close attention to the schedule: many theaters are \"dark\" (closed) on Mondays. Evening performances usually begin promptly at 7:00 PM or 8:00 PM, and they will not wait for you, so aim to arrive at least 30 minutes early to get through security and find your seat.",
    "image": "images/43.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.tdf.org"
  },
  {
    "id": "1788622003718",
    "name": "Gorge at Katz’s Delicatessen",
    "category": "dining",
    "day": "",
    "address": "205 E Houston St, New York, NY 10002",
    "desc": "• Budget about 60 to 90 minutes. It operates on a unique ticketing system—you are handed a paper ticket upon entry. DO NOT lose it, as you are charged a massive fee if you do, regardless of what you actually ate.\n\n• Since you are looking to gorge, their famous hand-carved pastrami and corned beef sandwiches are stacked with nearly a pound of meat each. Unless you have an enormous appetite, it is highly recommended to split one sandwich and perhaps add a side of potato latkes or a square knish.\n\n• The restaurant remains open 24 hours a day from Friday morning until Sunday night. If you want to avoid the notoriously long daytime lines, visiting late at night is a great strategy.",
    "image": "images/44.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://katzsdelicatessen.com"
  },
  {
    "id": "1788622634655",
    "name": "Time Out Market New York",
    "category": "viewpoints-photography",
    "day": "",
    "address": "55 Water St, Brooklyn, NY 11201",
    "desc": "• Budget 45 to 60 minutes to explore the historic Empire Stores building and take in the bustling atmosphere of this massive 24,000-square-foot space.\n\n• The primary draw here is the fifth-floor rooftop terrace. It is completely free for the public to access, regardless of whether you make a purchase inside.\n\n• The terrace offers incredible, unobstructed views of the Manhattan Bridge, the Brooklyn Bridge, and the downtown skyline, making it an essential stop for skyline photography.",
    "image": "images/45.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.timeoutmarket.com/newyork"
  },
  {
    "id": "1788622978482",
    "name": "One Times Square Skywalk",
    "category": "sightseeing",
    "day": "",
    "address": "1 Times Square, New York, NY 10036",
    "desc": "• Budget 45 to 60 minutes. The experience begins with a glass elevator ride ascending the exterior of the building, offering a dramatic preview of the views to come.\n\n• The 19th-floor open-air deck provides 360-degree wraparound views and features a transparent glass walkway suspended directly over Broadway. It offers an incredible vantage point for skyline photography, especially if you visit at night when the neon billboards truly come alive, but keep in mind that tripods and large bags are not permitted.\n\n• Make sure to stop by the interactive Confetti Wishing Wall; any wish you write here is saved and physically dispersed over the crowd during the official New Year's Eve ball drop.",
    "image": "images/46.jpg",
    "cost": 45,
    "packageId": null,
    "website": "https://www.timessquarenyc.org/entertainment/times-square-skywalk"
  },
  {
    "id": "1788624365119",
    "name": "The Plaza Hotel",
    "category": "sightseeing",
    "day": "",
    "address": "768 5th Ave, New York, NY 10019",
    "desc": "• Budget 15 to 30 minutes to view and photograph the French Renaissance chateau-style exterior of this historic landmark, famously known as Kevin McCallister's luxurious home base in the movie Home Alone 2: Lost in New York.\n\n• The building sits directly across from Grand Army Plaza and the Pulitzer Fountain at the southeast corner of Central Park, making it an incredibly picturesque and recognizable corner of the city.\n\n• Keep in mind that general public access to the main interior lobby and grand corridors is strictly limited to overnight hotel guests and residents, so you should expect to admire the architecture primarily from the outside.",
    "image": "images/47.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.theplazany.com"
  },
  {
    "id": "1788624789641",
    "name": "230 Fifth Rooftop Bar",
    "category": "dining",
    "day": "",
    "address": "1150 Broadway, New York, NY 10001",
    "desc": "• Budget 1.5 to 2 hours to soak in the bustling rooftop atmosphere and nightlife. Entry is free; pay individually for drinks.\n\n• The primary draw here is the massive open-air deck offering dramatic, unobstructed, up-close views of the Empire State Building illuminated at night. \n\n• If you are visiting during the colder winter months, the outdoor deck is famously transformed with transparent, heated \"igloos\" that allow you to enjoy the incredible skyline views while staying warm.",
    "image": "images/48.jpg",
    "cost": null,
    "packageId": null,
    "website": "http://www.230-fifth.com"
  },
  {
    "id": "1788625171675",
    "name": "Old City Hall Station",
    "category": "sightseeing",
    "day": "",
    "address": "Centre St & Chambers St, New York, NY 10007",
    "desc": "• Budget about 30 minutes. The station has been closed to the public since 1945. Unless you secure a rare, highly sought-after guided tour through the New York Transit Museum, you cannot actually walk on the platform.\n\n• The secret to seeing it is to take the downtown 6 train to its final stop at \"Brooklyn Bridge-City Hall.\" Instead of exiting, stay on the train. As the train turns around to head back uptown, it loops directly through the abandoned station.\n\n• Keep your eyes on the windows on the right side of the train car to catch a glimpse of the beautifully preserved 1904 architecture, including its elegant Guastavino tile arches, skylights, and vintage brass chandeliers.",
    "image": "images/49.jpg",
    "cost": 2.9,
    "packageId": null,
    "website": "https://www.nytransitmuseum.org"
  },
  {
    "id": "1788629109266",
    "name": "Roosevelt Island Tramway",
    "category": "sightseeing",
    "day": "",
    "address": "254 E 60th St, New York, NY 10022",
    "desc": "• Budget 30 to 45 minutes for the round-trip ride, or slightly longer if you plan to get off and walk along the East River promenade on the island.\n\n• You do not need a special ticket for this attraction. The tram is fully integrated into the MTA transit network, meaning you can simply tap your credit card at the OMNY reader or swipe a standard MetroCard to board.\n\n• The cabin travels up to 250 feet above the East River, gliding directly alongside the Ed Koch Queensboro Bridge. Stand near the front or side windows for incredible, sweeping aerial views of Midtown Manhattan.",
    "image": "images/50.jpg",
    "cost": 2.9,
    "packageId": null,
    "website": "https://rioc.ny.gov/302/Tram"
  },
  {
    "id": "1788716279125",
    "name": "The Elevated Acre",
    "category": "outdoors",
    "day": "",
    "address": "55 Water St, New York, NY 10041",
    "desc": "• Budget 30 to 45 minutes to relax and take photos in one of the Financial District's best-hidden urban oases. \n\n• Finding it is half the experience: look for the somewhat unassuming escalators tucked away near the sidewalk at the 55 Water Street office building. Taking them up reveals a lush, one-acre park hidden three stories above street level.\n\n• The space features a large lawn, walking paths, a boardwalk, and fantastic, unobstructed views overlooking the East River, the Brooklyn Bridge, and the Brooklyn skyline.",
    "image": "images/51.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://apops.mas.org/pops/m010025/"
  },
  {
    "id": "1788717674418",
    "name": "The Beekman (Temple Court Building)",
    "category": "sightseeing",
    "day": "",
    "address": "5 Beekman St, New York, NY 10038",
    "desc": "• Budget 15 to 20 minutes to step inside, look up, and photograph the breathtaking interior architecture. \n\n• Built in 1883, this was one of Manhattan's very first skyscrapers. The primary draw is the stunning nine-story Victorian atrium, which features beautifully intricate cast-iron railings and is topped by a massive pyramidal glass skylight. \n\n• Incredibly, this magnificent atrium was boarded up, walled off, and completely hidden from public view for over 70 years before being meticulously restored when the building was converted into a luxury hotel in 2016.\n\n• Because it is a fully operational hotel, you can confidently walk right in through the main entrance to view the atrium. Just be mindful and respectful of hotel guests and staff while taking your photographs.",
    "image": "images/52.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.thebeekman.com"
  },
  {
    "id": "1788718029044",
    "name": "The 'Ghostbusters' Firehouse",
    "category": "sightseeing",
    "day": "",
    "address": "14 N Moore St, New York, NY 10013",
    "desc": "• Budget 10 to 15 minutes to view and photograph the exterior of this historic 1903 Beaux-Arts building, famously known worldwide as the headquarters in the 1984 film Ghostbusters.\n\n• Because this is a fully active, working New York City Fire Department (FDNY) station, public access inside is not permitted. However, if the crew happens to have the bay doors open, you can often spot their Ghostbusters-themed apparatus and the original prop sign from the movie sequel hanging on the interior wall.\n\n• Make sure to look down while taking your photos: the fire company has fully embraced its pop-culture legacy, and there is a permanent Ghostbusters logo painted directly onto the sidewalk out front.",
    "image": "images/53.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.nyctourism.com/articles/fdny-ladder-company-eight"
  },
  {
    "id": "1788718323034",
    "name": "Ford Foundation Center for Social Justice (Atrium Garden)",
    "category": "sightseeing",
    "day": "",
    "address": "320 E 43rd St, New York, NY 10017",
    "desc": "• Budget 20 to 30 minutes to enjoy the serenity of this massive, 160-foot-tall indoor greenhouse located right in the middle of a bustling 1967 modernist office building. \n\n• The lush subtropical garden features a reflecting pool, a cascading fountain, and nearly 40 species of trees, vines, and shrubs that thrive inside the climate-controlled glass atrium.\n\n• CRITICAL ENTRY RULE: You can no longer simply walk in. All garden visitors must complete a pre-registration form on their official website by 5:00 PM the day prior to the visit, and you must present a valid photo ID to pass through security upon arrival.",
    "image": "images/54.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.fordfoundation.org/about/the-ford-foundation-center-for-social-justice/visitor-information"
  },
  {
    "id": "1788718610987",
    "name": "Trinity Place Bar & Restaurant (Bank Vault Bar)",
    "category": "entertainment-nightlife",
    "day": "",
    "address": "115 Broadway, New York, NY 10006",
    "desc": "• Budget 1 to 1.5 hours to grab a drink and soak in the historic, impenetrable atmosphere. \n\n• Located in the basement of a Gothic skyscraper, this subterranean bar is housed inside an authentic 1904 bank vault that was originally commissioned by Andrew Carnegie. \n\n• You enter the space by walking directly through one of two massive 35-ton steel doors built by the Mosler Safe Company. The vault was so heavy that it originally had to be sailed down the Hudson River and transported on custom-laid railway tracks from Battery Park just to reach the building.",
    "image": "images/55.jpg",
    "cost": 0,
    "packageId": null,
    "website": "http://www.trinityplacenyc.com"
  },
  {
    "id": "1788718890126",
    "name": "Le Boudoir",
    "category": "entertainment-nightlife",
    "day": "",
    "address": "135 Atlantic Ave, Brooklyn, NY 11201",
    "desc": "• Budget 1.5 to 2 hours for craft cocktails in this incredible Marie Antoinette-themed speakeasy. It is designed to emulate her opulent private chambers at Versailles, complete with plush red velvet banquettes, gilded mirrors, and antique sconces.\n\n• Finding it is part of the experience: you must enter the French bistro Chez Moi on street level, where the host will lead you to a hidden bookshelf door that opens to a narrow staircase descending into the subterranean bar.\n\n• Make sure to explore the back seating room. During renovations, the owners discovered that the space connects to the fabled 1844 Atlantic Avenue Tunnel (the world's oldest subway tunnel), and they incorporated the preserved, vaulted brick coal room directly into the lounge area.",
    "image": "images/56.jpg",
    "cost": null,
    "packageId": null,
    "website": "http://www.boudoirbk.com"
  },
  {
    "id": "1788719088794",
    "name": "Chinatown Ice Cream Factory",
    "category": "dining",
    "day": "",
    "address": "65 Bayard St, New York, NY 10013",
    "desc": "• Budget 15 to 30 minutes, though you should expect a line if you visit on a warm weekend afternoon or immediately following dinner hours.\n\n• Operating since 1978, this legendary, family-run shop is famous for blending traditional American ice cream techniques with iconic Asian flavors. \n\n• While they offer standard flavors like vanilla and chocolate, the real draw here is their \"regular\" menu which features their famous Black Sesame, Ube (purple yam), Lychee, Pandan, and Durian.",
    "image": "images/57.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.chinatownicecreamfactory.com"
  },
  {
    "id": "1788719557018",
    "name": "New York Transit Museum",
    "category": "museums-culture",
    "day": "",
    "address": "99 Schermerhorn St, Brooklyn, NY 11201",
    "desc": "• Budget 1.5 to 2 hours to explore the exhibits and walk through the rolling stock.\n\n• The museum offers a uniquely immersive experience because it is housed entirely underground within a decommissioned 1936 subway station (the former Court Street station). You literally descend the subway stairs to enter the exhibits.\n\n• The main highlight is down on the platform level, which features a massive fleet of fully restored vintage subway cars dating back to the early 1900s. Visitors are allowed to step inside, sit on the original woven rattan seats, and read period-accurate vintage advertisements hanging in the cars.",
    "image": "images/58.jpg",
    "cost": 13,
    "packageId": null,
    "website": "https://www.nytransitmuseum.org"
  },
  {
    "id": "1788720311468",
    "name": "Pier 54: The Titanic’s Arrival Destination",
    "category": "sightseeing",
    "day": "",
    "address": "Hudson River Park at W 13th St, New York, NY 10014",
    "desc": "• Budget 10 to 15 minutes to view and photograph this incredibly significant piece of maritime history. \n\n• The pier structure itself has long since rotted away and was recently replaced by the modern Little Island park (Pier 55) right next door. However, the original rusted iron entrance archway remains standing on the waterfront promenade.\n\n• If you look closely at the rusted steel beam at the top of the archway, you can still clearly read the faded, overlapping cut-out lettering for the \"Cunard\" and \"White Star\" lines. \n\n• This arch is the exact threshold where the RMS Carpathia docked in 1912 to disembark the 705 rescued survivors of the Titanic. It is also the very same pier where the RMS Lusitania departed in 1915 on its tragic final voyage.",
    "image": "images/59.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://hudsonriverpark.org"
  },
  {
    "id": "1788720569311",
    "name": "Brooklyn Botanic Garden",
    "category": "outdoors",
    "day": "",
    "address": "990 Washington Ave, Brooklyn, NY 11225",
    "desc": "• Budget 1.5 to 2.5 hours to wander through the various distinct gardens spread across the massive 52-acre property.\n\n• The most famous highlights include the Japanese Hill-and-Pond Garden (one of the oldest Japanese-inspired gardens outside of Japan), the Cranford Rose Garden, and the indoor Steinhardt Conservatory.\n\n• Logistical tip: If you are visiting in late April or early May, the Cherry Esplanade is arguably the most spectacular spot in all of New York City for cherry blossom viewing, though you should expect peak crowds during this window.",
    "image": "images/60.jpg",
    "cost": 22,
    "packageId": null,
    "website": "https://www.bbg.org"
  },
  {
    "id": "1788722089918",
    "name": "Greenacre Park",
    "category": "outdoors",
    "day": "",
    "address": "217 E 51st St, New York, NY 10022",
    "desc": "• Budget 15 to 20 minutes for a quick rest and some photos in this multi-level pocket park hidden seamlessly between two Midtown buildings.\n\n• The main draw is the dramatic 25-foot waterfall built into the back wall, which drowns out street noise and creates a genuinely tranquil atmosphere.\n\n• Logistical tip: The heavy shade from the honey locust trees makes this a perfect, quiet spot to escape the intense afternoon sun during summer visits.",
    "image": "images/61.jpg",
    "cost": 0,
    "packageId": null,
    "website": ""
  },
  {
    "id": "1788721807480",
    "name": "Marilyn Monroe’s Subway Grate",
    "category": "sightseeing",
    "day": "",
    "address": "Lexington Ave & E 52nd St, New York, NY 10022",
    "desc": "• Budget 5 to 10 minutes for a quick stop and photo op at this famous piece of cinematic history. \n\n• This is the exact subway grate where Marilyn Monroe stood in 1954 to film the iconic, skirt-blowing scene for the movie The Seven Year Itch. The filming originally took place outside the now-demolished Trans-Lux 52nd Street Theatre.\n\n• Because this is an active, heavily trafficked New York City sidewalk in the middle of Midtown, be mindful of passing pedestrians and commuters when taking your photographs.",
    "image": "images/62.jpg",
    "cost": 0,
    "packageId": null,
    "website": ""
  },
  {
    "id": "1788722953888",
    "name": "House of Wax",
    "category": "entertainment-nightlife",
    "day": "",
    "address": "445 Albee Square W, Brooklyn, NY 11201",
    "desc": "• Budget 45 to 60 minutes to take in the macabre atmosphere and view the highly unusual exhibits.\n\n• Located inside the City Point complex next to the Alamo Drafthouse cinema, this dimly lit lounge houses a rare, fully intact collection of late 19th-century anatomical wax figures originally created in Germany.\n\n• The space is decorated like a vintage Victorian oddities parlor. It is an incredible spot for moody, atmospheric photography, but remember to be respectful of the space and other patrons while taking pictures.",
    "image": "images/63.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://drafthouse.com/nyc/theater-bar/downtown-brooklyn"
  },
  {
    "id": "1788723221034",
    "name": "Gimbel's Bridge",
    "category": "sightseeing",
    "day": "",
    "address": "198-100 W 32nd St, New York, NY 10001",
    "desc": "• Budget 5 to 10 minutes to look up and photograph this incredible piece of forgotten architectural history suspended over West 32nd Street.\n\n• Built in 1925, this three-story Art Deco skywalk once connected the massive Gimbels department store to its administrative annex, allowing pedestrians to cross the congested street in style.\n\n• The bridge was designed by the architectural firm Shreve and Lamb, who would go on to design the Empire State Building just a few years later.\n\n• Today, the bridge is completely abandoned and sealed off, serving as a ghostly, oxidized green monument to the golden age of New York retail.",
    "image": "images/64.jpg",
    "cost": 0,
    "packageId": null,
    "website": ""
  },
  {
    "id": "1788723484494",
    "name": "New York Federal Gold Vault",
    "category": "museums-culture",
    "day": "",
    "address": "33 Liberty St, New York, NY 10045",
    "desc": "• Budget about 1 hour for the guided tour, which takes you 80 feet below street level to see the famed gold vault.\n\n• The vault holds thousands of tons of gold bars entrusted to the New York Fed by foreign central banks and international organizations.\n\n• Logistical tip: Space is extremely limited. You must book a tour online exactly 30 days in advance, and tickets regularly run out within minutes of being released so you must plan ahead.",
    "image": "images/65.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.newyorkfed.org/aboutthefed/visiting"
  },
  {
    "id": "1788723670418",
    "name": "Berlin Wall Section NY",
    "category": "sightseeing",
    "day": "",
    "address": "393 S End Ave, New York, NY 10280",
    "desc": "• Budget 10 to 15 minutes to view and photograph this authentic segment of the inner wall located in Battery Park City.\n\n• Gifted to the city in 2004 by the German Consulate, this massive 2.75-ton slab originally stood in downtown Berlin between Potsdamer Platz and Leipziger Platz.\n\n• It features original, brightly colored street art on the west-facing side, painted by artists who were famous for sneaking to the wall to paint before its fall.",
    "image": "images/66.jpg",
    "cost": 0,
    "packageId": null,
    "website": ""
  },
  {
    "id": "1788723795881",
    "name": "Fearless Girl Statue",
    "category": "sightseeing",
    "day": "",
    "address": "2-26 Broad St, New York, NY 10005",
    "desc": "• Budget 5 to 10 minutes to photograph this iconic bronze sculpture in the heart of the Financial District.\n\n• Originally placed facing the Charging Bull on International Womens Day in 2017, the statue was later relocated to its current permanent home directly facing the New York Stock Exchange on Broad Street.\n\n• Designed by artist Kristen Visbal, the statue was created to promote female empowerment and highlight the need for gender diversity in corporate leadership.",
    "image": "images/67.jpg",
    "cost": 0,
    "packageId": null,
    "website": ""
  },
  {
    "id": "1788724055926",
    "name": "High Bridge",
    "category": "outdoors",
    "day": "",
    "address": "Harlem River Dr, New York, NY 10033",
    "desc": "• Budget 30 to 45 minutes to walk across and take in the unique views of the Harlem River.\n\n• Originally completed in 1848 as part of the Croton Aqueduct system to bring fresh water into the city, this is officially the oldest standing bridge in New York City.\n\n• It was recently restored and reopened as a pedestrian and bicycle-only path connecting Washington Heights in Manhattan to the Highbridge neighborhood in the Bronx, making it a highly peaceful, completely car-free historic walkway.",
    "image": "images/68.jpg",
    "cost": 0,
    "packageId": null,
    "website": "http://www.nycgovparks.org/park-features/highbridge-park"
  },
  {
    "id": "1788724470230",
    "name": "United Palace Theatre",
    "category": "entertainment-nightlife",
    "day": "",
    "address": "4140 Broadway, New York, NY 10033",
    "desc": "• Budget 1.5 to 3 hours depending on whether you are attending a classic movie screening, a live performance, or a guided architectural tour.\n\n• Opened in 1930 as one of the original Loew's Wonder Theatres, the interior is an absolutely breathtaking mix of neo-classical, Mayan, and Indo-Deco architectural styles.\n\n• The ornate golden details and intricate ceiling designs make this a spectacular venue to pull out the a6600 and capture some incredible low-light architectural photography.\n\n• Logistical tip: The venue does not operate with standard daily museum hours, so you will need to book tickets to a specific event or one of their scheduled historic tours to gain access to the interior.",
    "image": "images/69.jpg",
    "cost": null,
    "packageId": null,
    "website": "http://www.unitedpalace.org/"
  },
  {
    "id": "1788724805324",
    "name": "Bryant Park Bathroom",
    "category": "outdoors",
    "day": "",
    "address": "42nd St and 6th Ave, New York, NY 10018",
    "desc": "• Budget 5 to 10 minutes to experience what is widely considered the most luxurious public restroom in all of New York City.\n\n• Located along the 42nd Street side of the park, this facility famously features classical music, fresh floral arrangements, imported tiles, and full-time attendants.\n\n• Logistical tip: Because of its pristine reputation and central location right behind the New York Public Library, there is often a line out the door during peak afternoon hours, but it moves very quickly.",
    "image": "images/70.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://bryantpark.org/"
  },
  {
    "id": "1788725048434",
    "name": "Times Square Hum",
    "category": "sightseeing",
    "day": "",
    "address": "Broadway between 45th St and 46th St, New York, NY 10036",
    "desc": "• Budget 10 to 15 minutes to locate and experience this permanently installed, completely hidden sound art piece right in the middle of the busiest intersection in the city.\n\n• Created by experimental artist Max Neuhaus in 1977, the installation emanates a deeply resonant, continuous harmonic drone from beneath the subway grates located on the pedestrian traffic island.\n\n• Logistical tip: Because this is a purely auditory experience, you have to stand directly on top of the grating and focus your hearing to separate the intentional artistic hum from the chaotic background noise of the surrounding traffic.",
    "image": "images/71.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.diaart.org/visit/visit-our-locations-sites/max-neuhaus-times-square"
  },
  {
    "id": "1788725580933",
    "name": "The Woolworth Building",
    "category": "sightseeing",
    "day": "",
    "address": "233 Broadway, New York, NY 10007",
    "desc": "• Budget 15 minutes to admire the exterior from City Hall Park, or 60 to 90 minutes if you book a guided lobby tour.\n\n• Completed in 1913, this stunning neo-Gothic skyscraper was the tallest building in the world until 1930 and remains one of the most iconic silhouettes on the downtown skyline.\n\n• The exterior terracotta detailing at the top of the tower is incredibly intricate. If you have your Sony a6600 and that 100-400mm lens with you, this is a phenomenal spot to test the optical steady shot and zoom in on the gargoyles and architectural flourishes from way down at street level.\n\n• Logistical tip: The breathtaking lobby is strictly closed to the general public, so you must book an official tour in advance through their website if you want to see the famous stained glass ceiling and ornate mosaics inside.",
    "image": "images/72.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://woolworthtoursnyc.com"
  },
  {
    "id": "1788725827225",
    "name": "Holiday Nostalgia Train",
    "category": "sightseeing",
    "day": "",
    "address": "Route varies yearly (check website for current departure stations)",
    "desc": "• Budget about 1 to 2 hours to ride the vintage subway cars, walk between the cars, and photograph the restored interiors.\n\n• This seasonal event runs exclusively on weekends between Thanksgiving and Christmas, featuring authentic 1930s R1-9 train cars complete with original rattan seats, ceiling fans, drop-sash windows, and vintage subway advertisements.\n\n• Logistical tip: Because the train operates on active subway lines, the exact route and departure stations change slightly from year to year. You will need to check the official museum website for the current schedule, but riding it only costs a standard subway tap!",
    "image": "images/73.jpg",
    "cost": 2.9,
    "packageId": null,
    "website": "https://www.nytransitmuseum.org/nostalgiarides"
  },
  {
    "id": "1788726238221",
    "name": "Long Lines Building",
    "category": "skyscrapers",
    "day": "",
    "address": "33 Thomas St, New York, NY 10007",
    "desc": "• Budget 5 to 10 minutes to walk by and photograph this massive, windowless brutalist skyscraper that looks more like an impenetrable castle defense fortress than a standard city building.\n\n• Designed by architect John Carl Warnecke in 1974 to house telephone switching equipment, the structure was specifically engineered to be entirely self-sufficient and withstand nuclear fallout.\n\n• Logistical tip: There is absolutely no public access to the interior, which investigative journalists have strongly linked to a massive NSA surveillance hub, so you will only be able to view and photograph the looming exterior from the street.",
    "image": "images/74.jpg",
    "cost": 0,
    "packageId": null,
    "website": ""
  },
  {
    "id": "1788726722834",
    "name": "Macy's",
    "category": "shopping",
    "day": "",
    "address": "151 West 34th Street, New York, NY 10001",
    "desc": "• Budget 15 to 20 minutes to explore the upper floors of the department store and take a ride on this unique piece of retail history.\n\n• Installed by the Otis Elevator Company in the 1920s and 1930s, these creaky, iconic escalators are constructed from solid oak and ash.\n\n• Logistical tip: You can find them near the elevators and women's restrooms, as the original wooden treads still operate from the second floor all the way up to the ninth floor.",
    "image": "images/75.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.macys.com"
  },
  {
    "id": "1788726887707",
    "name": "REACH: New York",
    "category": "sightseeing",
    "day": "",
    "address": "34th St - Herald Square Subway Station, New York, NY 10001",
    "desc": "• Budget 5 to 10 minutes to play with this interactive urban instrument while waiting for a train.\n\n• Created by artist Christopher Janney and installed in 1995, it consists of a green rectangular structure suspended above both the uptown and downtown N and R subway platforms at the 34th Street Herald Square station.\n\n• If you wave your hand in front of the sensors, it interrupts a beam of light and triggers a range of sounds like a marimba, a flute, or environmental noises, allowing you to create spontaneous music with commuters on the opposite platform.",
    "image": "images/76.jpg",
    "cost": 2.9,
    "packageId": null,
    "website": "https://www.janneysound.com/project/reach-new-york"
  },
  {
    "id": "1788728055119",
    "name": "Titanic Memorial Lighthouse",
    "category": "sightseeing",
    "day": "",
    "address": "Fulton St and Pearl St, New York, NY 10038",
    "desc": "• Budget 5 to 10 minutes to view this 60-foot-tall memorial lighthouse honoring the passengers and crew who perished on the RMS Titanic.\n\n• The monument was originally dedicated in 1913 on the roof of the Seamens Church Institute and featured a time ball that dropped daily at noon.\n\n• It was moved to its current location anchoring Titanic Memorial Park at the entrance to the South Street Seaport Historic District in 1976.\n\n• Logistical tip: The South Street Seaport Museum completed a restoration of the artifact, including aesthetic improvements and the stabilization of the light and time ball, in the summer of 2026.",
    "image": "images/77.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://southstreetseaportmuseum.org/about-titanic-memorial-lighthouse/"
  },
  {
    "id": "1788728220857",
    "name": "Grand Central Oyster Bar",
    "category": "dining",
    "day": "",
    "address": "89 E 42nd St, New York, NY 10017",
    "desc": "• Budget 1 to 2 hours to sit at the sweeping counters and soak in the century-old atmosphere of this subterranean dining landmark.\n\n• Opened in 1913 alongside the terminal itself, the space is famous for its stunning, cavernous Guastavino tiled vault ceilings, which make for fantastic architectural photography.\n\n• With a massive daily menu of fresh seafood, it is a fun spot to grab a bite and see how the local Atlantic sea bass compares to what you usually target out in the English Channel.\n\n• Logistical tip: The restaurant is notoriously loud due to the unique acoustic properties of the curved tile ceilings, making it a bustling, highly energetic dining experience rather than a quiet, intimate one.",
    "image": "images/78.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.oysterbarny.com/"
  },
  {
    "id": "1788813671557",
    "name": "Crabs of Cleopatra’s Needle",
    "category": "sightseeing",
    "day": "",
    "address": "East Drive at 81st Street, New York, NY 10024",
    "desc": "• Budget 10 to 15 minutes to examine the massive bronze crabs supporting the 71-foot-tall, 3,000-year-old Egyptian obelisk.\n\n• When the Romans moved the obelisk to Alexandria in 12 BCE, they added bronze crabs to support its damaged base. The ones currently outside are 900-pound replicas cast at the Brooklyn Navy Yard in 1880, while two of the surviving ancient Roman originals are displayed inside the Metropolitan Museum of Art.\n\n• Logistical tip: The monument sits on a quiet, slightly elevated knoll known as Greywacke Knoll, making it a fantastic and peaceful spot to step away from the heavy pedestrian traffic near the museum entrance.",
    "image": "images/79.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.centralparknyc.org/locations/obelisk"
  },
  {
    "id": "1788814110975",
    "name": "Pomander Walk",
    "category": "sightseeing",
    "day": "",
    "address": "261 W 94th St, New York, NY 10025",
    "desc": "• Budget 5 to 10 minutes to peek through the wrought-iron gates and photograph this highly unusual hidden street on the Upper West Side.\n\n• Built in 1921, this private residential alleyway was designed to look exactly like a quaint Tudor-style English village, providing a striking architectural contrast to the massive Manhattan apartment blocks surrounding it.\n\n• With its colorful half-timbered facades, slate roofs, and tiny gardens, it offers a fantastic bit of real-world visual inspiration if you are generating new architectural backdrops for The Legend of Valoria comic strips.\n\n• Logistical tip: Because it is a privately owned and gated residential complex, you cannot actually walk down the street itself. The best views are looking directly through the gates on West 94th Street and West 95th Street.",
    "image": "images/80.jpg",
    "cost": 0,
    "packageId": null,
    "website": ""
  },
  {
    "id": "1788814461835",
    "name": "Brooklyn Ice Cream Factory",
    "category": "dining",
    "day": "",
    "address": "14 Old Fulton St, Brooklyn, NY 11201",
    "desc": "• Budget 15 to 30 minutes to grab a scoop and walk down to the nearby piers for spectacular views of the Manhattan skyline.\n\n• They make all their ice cream in small, handcrafted batches with very simple ingredients. It is a perfect spot to take a temporary vacation from strict exact-gram meal tracking and enjoy a classic, high-quality treat.\n\n• Logistical tip: They moved a few years ago from their original historic fireboat house directly on the water to just a block inland on Old Fulton Street, but it remains an absolute staple reward after completing the long walk across the Brooklyn Bridge.",
    "image": "images/81.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://brooklynicecreamfactory.com"
  },
  {
    "id": "1788815108107",
    "name": "Private Passage",
    "category": "sightseeing",
    "day": "",
    "address": "Hudson River Park at W 55th St and 12th Ave, New York, NY 10019",
    "desc": "• Budget 10 to 15 minutes to peer into the portholes of this massive, highly unexpected riverside art installation.\n• Created by artist Malcolm Cochran in 2005, the sculpture is a 30-foot-long bronze and zinc wine bottle resting entirely on its side.\n• When you look through the circular windows, you will see a highly detailed, completely monochromatic recreation of an interior stateroom from the famous 1930s ocean liner, the RMS Queen Mary.\n• Logistical tip: This piece is located in the Clinton Cove section of Hudson River Park. It is a fantastic spot to pause and rest if you are walking the long Hudson River Greenway along the west side of Manhattan.",
    "image": "images/82.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://hudsonriverpark.org/activities/private-passage"
  },
  {
    "id": "1788815474719",
    "name": "Green-Wood Cemetery",
    "category": "outdoors",
    "day": "",
    "address": "25th St, Brooklyn, NY 11232",
    "desc": "• Budget 2 to 3 hours to wander the 478 acres of rolling hills, historic mausoleums, and glacial ponds in this massive National Historic Landmark.\n• The spectacular Gothic Revival main entrance gates are a masterpiece of design, offering fantastic real-world visual inspiration for the medieval castle structures and stone carvings in The Legend of Valoria.\n• Keep an eye and ear out for the famous colony of wild, bright green Monk Parakeets that nest right in the ornate spires of the main gate.\n• Logistical tip: The expansive grounds and high architectural details make this a prime location to mount that 100-400mm lens on the a6600, whether you are zooming in on the parakeets up in the arches or capturing the distant Manhattan skyline views from the top of Battle Hill.",
    "image": "images/83.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.green-wood.com"
  },
  {
    "id": "1788815777032",
    "name": "The Hangman's Elm",
    "category": "outdoors",
    "day": "",
    "address": "Washington Square Park (Northwest corner), New York, NY 10012",
    "desc": "• Budget 10 to 15 minutes to locate this massive English Elm in the northwest corner of Washington Square Park, near the MacDougal Street entrance.\n• Standing at over 110 feet tall, it is widely believed to be the oldest known tree in Manhattan, with estimates placing its age at over 330 years old.\n• While historians heavily debate whether anyone was actually executed from its branches, the dark local legends and towering, gnarled appearance give it a fantastic gothic atmosphere that could easily inspire a creepy ancient forest setting for your next Valoria comic strip.\n• Logistical tip: The park is heavily shaded and bustling with musicians and performers, making it a great place to sit on a bench and take a break while exploring the Village.",
    "image": "images/84.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.nycgovparks.org/parks/washington-square-park"
  },
  {
    "id": "1788816187575",
    "name": "The Daily News Building Globe",
    "category": "sightseeing",
    "day": "",
    "address": "220 E 42nd St, New York, NY 10017",
    "desc": "• Budget 15 to 20 minutes to step inside this stunning Art Deco lobby and watch the massive, illuminated indoor globe rotate.\n• Stepping into the real-world Daily Planet headquarters from the classic 1978 Superman film is a fantastic sightseeing stop for anyone actively crafting their own comic universes and graphic novels.\n• The globe is set in a recessed pit surrounded by brass lines indicating distances to major world cities, with vintage weather and meteorological instruments lining the surrounding walls.\n• Logistical tip: The lobby lighting is incredibly moody and contrast-heavy. If you want a sharp handheld shot with the a6600, you will need to bump up the ISO and lean on the camera stabilization to properly capture the glowing globe.",
    "image": "images/85.jpg",
    "cost": 0,
    "packageId": null,
    "website": ""
  },
  {
    "id": "1788816465896",
    "name": "General Grant National Memorial",
    "category": "sightseeing",
    "day": "",
    "address": "W 122nd St & Riverside Dr, New York, NY 10027",
    "desc": "• Budget 30 to 45 minutes to view the grand neoclassical exterior and the solemn interior rotunda of the largest mausoleum in North America.\n• Modeled after the ancient Mausoleum at Halicarnassus, the imposing marble architecture and massive twin sarcophagi of President Ulysses S. Grant and his wife Julia offer an incredibly regal atmosphere that could easily serve as visual reference material for a royal crypt in The Legend of Valoria.\n• Logistical tip: Step across the plaza to capture wide exterior shots with your a6600, as the massive granite structure demands a bit of distance to fully fit into the frame, especially if you are using a longer lens setup.",
    "image": "images/86.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.nps.gov/gegr/index.htm"
  },
  {
    "id": "1788816662625",
    "name": "Irish Hunger Memorial",
    "category": "sightseeing",
    "day": "",
    "address": "North End Ave & Vesey St, New York, NY 10280",
    "desc": "• Budget 20 to 30 minutes to walk through this incredibly unique landscape installation located right in the middle of Battery Park City.\n• Designed by artist Brian Tolle, the memorial recreates a rugged Irish hillside using stones from all 32 of the counties in Ireland, native flora, and an authentic reconstructed 19th-century stone cottage.\n• The juxtaposition of an abandoned, rural stone ruin set directly against the modern glass skyscrapers of Lower Manhattan offers a striking visual contrast that is perfect for gathering environmental reference material for abandoned settlements or ancient ruins in The Legend of Valoria.\n• Logistical tip: The path winds upwards to a cantilevered overlook projecting out toward the water, so be sure to walk all the way to the top for a fantastic elevated view of the Hudson River.",
    "image": "images/87.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://bpca.ny.gov/place/irish-hunger-memorial"
  },
  {
    "id": "1788890634915",
    "name": "The New Yorker Hotel",
    "category": "skyscrapers",
    "day": "",
    "address": "481 8th Ave, New York, NY 10001",
    "desc": "• Budget 15 to 20 minutes to admire the imposing Art Deco exterior, check out the lower lobby, and view the historical plaques.\n• Built in 1930, this tiered architectural masterpiece is incredibly famous in scientific and historical circles as the final residence of inventor Nikola Tesla, who lived in rooms 3327 and 3328 for the last ten years of his life.\n• You can find memorial plaques dedicated to him both inside the lobby and on the exterior of the building near the entrance.\n• Logistical tip: The massive red neon sign on the roof is best photographed from a distance. If you step back a few blocks down 34th Street, you can use the 100-400mm lens on your Sony a6600 to compress the background and get a fantastic, cinematic shot of the iconic lettering glowing against the skyline.",
    "image": "images/88.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.newyorkerhotel.com"
  },
  {
    "id": "1788892273508",
    "name": "Paley Park",
    "category": "outdoors",
    "day": "",
    "address": "3 E 53rd St, New York, NY 10022",
    "desc": "• Budget 15 to 30 minutes to sit and relax in this pioneering vest-pocket park located right in the middle of bustling Midtown.\n• Designed by Zion Breen Richardson Associates in 1967, it features ivy-covered walls, light canopy trees, and a spectacular 20-foot water wall that completely drowns out the heavy city traffic noise.\n• Finding a peaceful, isolated sanctuary hidden in the middle of a chaotic environment is a fantastic spatial concept you could adapt for a secret refuge or elven enclave in your Legend of Valoria comics.\n• Logistical tip: Because the park is very small and enclosed, using the 100-400mm lens on your Sony a6600 will be incredibly tight. However, you can use that heavy zoom to capture highly abstract, compressed detail shots of the water crashing down the textured stone face of the waterfall.",
    "image": "images/90.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.paleypark.org"
  },
  {
    "id": "1788893062429",
    "name": "The Forgotten Entrance to Clinton Hall",
    "category": "sightseeing",
    "day": "",
    "address": "Astor Place Subway Station, New York, NY 10003",
    "desc": "• Budget 5 to 10 minutes to spot this bricked-up doorway while waiting for the downtown 6 train.\n• Located directly on the subway platform, the sealed archway features a carved lintel reading Clinton Hall and originally served as a private entrance to the Mercantile Library in the early 1900s.\n• The site above was once the Astor Place Opera House, famous for the deadly 1849 Shakespeare Riots, making it a place steeped in intense, dark history.\n• The concept of a sealed, forgotten underground door leading to a lost repository of knowledge is an absolutely perfect premise to adapt for a dungeon or hidden archive in your next Legend of Valoria storyline.\n• Logistical tip: You will specifically need to be on the southbound platform to see the doorway, so it is easiest to view right as you are taking the train downtown toward Lower Manhattan or Brooklyn.",
    "image": "images/91.jpg",
    "cost": 2.9,
    "packageId": null,
    "website": ""
  },
  {
    "id": "1788893298997",
    "name": "Roosevelt Island Octagon Tower",
    "category": "sightseeing",
    "day": "",
    "address": "888 Main St, Roosevelt Island, NY 10044",
    "desc": "• Budget 15 to 20 minutes to admire the exterior and step into the lobby of this striking eight-sided rotunda located near the northern end of the island.\n• Originally built in 1841, it served as the imposing main entrance to the New York City Lunatic Asylum before eventually being restored and incorporated into a modern residential complex.\n• The unique octagonal design, blue-gray stone construction, and grand flying stairs offer perfect architectural reference material for designing a fortified stone keep in your Stronghold Crusader layouts, or a wizard tower in The Legend of Valoria.\n• Logistical tip: The most scenic way to get to the island is by taking the Roosevelt Island Tramway over the East River, which provides a fantastic opportunity to use your Sony a6600 for sweeping, elevated shots of the Manhattan skyline along the way.",
    "image": "images/92.jpg",
    "cost": null,
    "packageId": null,
    "website": ""
  },
  {
    "id": "1788893615398",
    "name": "Giant Needle and Button",
    "category": "sightseeing",
    "day": "",
    "address": "7th Ave & W 39th St, New York, NY 10018",
    "desc": "• Budget 5 to 10 minutes to grab a photo of this quirky pop-art sculpture located right in the heart of the Garment District.\n• The structure features a massive 31-foot steel needle threading an equally oversized 14-foot yellow button, leaning over a small glass booth.\n• It stands alongside a bronze statue of a garment worker at a sewing machine, paying homage to the massive fashion manufacturing industry that built the neighborhood.\n• Logistical tip: Because it sits right on a busy intersection, using the 100-400mm lens on your Sony a6600 from a block or two away can beautifully compress the giant yellow button against the chaotic blur of the yellow taxi cabs passing in the background.",
    "image": "images/93.jpg",
    "cost": 0,
    "packageId": null,
    "website": ""
  },
  {
    "id": "1788893800644",
    "name": "The Location of Paul's Boutique",
    "category": "sightseeing",
    "day": "",
    "address": "Corner of Ludlow St and Rivington St, New York, NY 10002",
    "desc": "• Budget 10 to 15 minutes to visit this iconic intersection, which was officially renamed to honor the legendary hip-hop trio [1.2.5].\n• This is the exact spot where the panoramic cover photo for the 1989 album Paul's Boutique was taken [1.2.5]. The band hung a temporary sign under the awning of what was then Lee's Sportswear to create the fictional shop [1.2.5].\n• The corner now features a tribute mural by artist Danielle Mastrion, capturing the gritty, layered aesthetic of the 1980s [1.1.1].\n• Logistical tip: The heavy brickwork and dense street art of the area offer fantastic texture references for urban environments in The Legend of Valoria. A 100-400mm lens will be much too long to capture the entire intersection, but mounting it on your Sony a6600 will let you pick out highly detailed, compressed shots of the mural art and the street signs high above the traffic.",
    "image": "images/94.jpg",
    "cost": null,
    "packageId": null,
    "website": ""
  },
  {
    "id": "1788894472996",
    "name": "Staple Street Skybridge",
    "category": "sightseeing",
    "day": "",
    "address": "9 Jay St, New York, NY 10013",
    "desc": "• Budget 5 to 10 minutes to walk down this incredibly narrow, moody cobblestone alleyway tucked away in the heart of Tribeca.\n• The iconic three-story wrought-iron footbridge was built in 1907 to connect the New York Hospital House of Relief to its annex across the street, allowing medical staff to transfer patients without navigating the chaotic street traffic below.\n• The cast-iron architecture, deep shadows, and claustrophobic framing of the brick buildings provide exceptional visual reference material for designing elevated walkways or tight urban corridors in a medieval city in The Legend of Valoria.\n• Logistical tip: The alley is notoriously dark and narrow. Using the 100-400mm lens on your Sony a6600 from either end of the block will let you drastically compress the distance, pulling the brick facades and the iron bridge tightly together for a highly cinematic and atmospheric shot.",
    "image": "images/95.jpg",
    "cost": 0,
    "packageId": null,
    "website": ""
  },
  {
    "id": "1788894710883",
    "name": "Roosevelt Island Lighthouse",
    "category": "sightseeing",
    "day": "",
    "address": "Lighthouse Park, Roosevelt Island, NY 10044",
    "desc": "• Budget 15 to 20 minutes to walk to the very edge of Lighthouse Park to view the structure and take in the panoramic views of the East River.\n• Built in 1872 and designed by James Renwick Jr., this 50-foot octagonal tower was constructed entirely out of rugged gray gneiss stone quarried directly from the island itself by inmates of the nearby penitentiary.\n• The gothic masonry and isolated waterfront placement offer a fantastic visual reference for a coastal watchtower or a solitary magical outpost in The Legend of Valoria.\n• Logistical tip: Because you have plenty of wide-open space in the park, you can easily step far back and use the 100-400mm lens on your Sony a6600 to capture incredibly sharp, compressed details of the lantern room and the heavy stone blocks at the top of the tower.",
    "image": "images/96.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.nycgovparks.org/parks/roosevelt-island-lighthouse-park"
  },
  {
    "id": "1788895772155",
    "name": "The Oldest Fence in New York",
    "category": "sightseeing",
    "day": "",
    "address": "Bowling Green, New York, NY 10004",
    "desc": "• Budget 10 to 15 minutes to examine the cast-iron fence surrounding Bowling Green, which is the oldest public park in New York City.\n• Erected in 1771 to protect a gilded lead equestrian statue of King George III, the barrier is a rare surviving example of pre-Revolutionary War ironworks.\n• On July 9, 1776, after the reading of the Declaration of Independence, the Sons of Liberty famously tore down the statue and sawed off the crown-shaped finials on the tops of the fence. You can still run your hands over the uneven, sawed-off tops today.\n• Logistical tip: The jagged cuts on top of the iron posts are fantastic textural details to photograph. Using the zoom lens on your Sony a6600 to capture the rough, 250-year-old saw marks up close will give you excellent visual references for historic battle damage or ancient, repurposed barriers in The Legend of Valoria.",
    "image": "images/97.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.nycgovparks.org/parks/bowling-green"
  },
  {
    "id": "1788896238118",
    "name": "The Standard Oil Building",
    "category": "sightseeing",
    "day": "",
    "address": "26 Broadway, New York, NY 10004",
    "desc": "• Budget 10 to 15 minutes to take in the imposing, curved limestone facade of John D. Rockefellers former oil monopoly headquarters, located right across from Bowling Green.\n• The massive base of the building actively bends to follow the historic curve of Broadway, creating a fortress-like wall that offers excellent architectural inspiration for an imposing, impenetrable citadel in The Legend of Valoria.\n• Look all the way up to the top of the 480-foot tower to spot a massive limestone cauldron; it was originally designed to emit illuminated steam at night to resemble a giant, burning oil lamp.\n• Logistical tip: The cavernous, narrow streets of the Financial District make it impossible to photograph the entire building from up close, but pointing the 100-400mm lens on your Sony a6600 straight up is absolutely perfect for picking out the carved eagles and the monumental cauldron at the very peak.",
    "image": "images/98.jpg",
    "cost": 0,
    "packageId": null,
    "website": ""
  },
  {
    "id": "1788896446950",
    "name": "Jeffrey's Hook Light",
    "category": "sightseeing",
    "day": "",
    "address": "Fort Washington Park, Hudson River Greenway, New York, NY 10032",
    "desc": "• Budget 20 to 30 minutes to hike down the riverside path and appreciate the striking visual contrast of this tiny, 40-foot-tall red iron tower sitting directly beneath the colossal steel beams of the George Washington Bridge.\n• Originally erected in 1880 and moved to this specific hook of land in 1921, it gained worldwide fame through a classic 1942 childrens book about its survival against modern infrastructure.\n• The extreme difference in scale between the small, historical beacon and the overwhelming, industrial bridge above is an incredible visual concept to adapt for showing tiny watchposts resting in the shadows of towering citadels or giant ancient ruins in The Legend of Valoria.\n• Logistical tip: To get a truly cinematic shot with your Sony a6600, walk a bit further north or south along the Hudson River Greenway. Using your 100-400mm lens from a distance will brilliantly compress the perspective, making the gigantic steel bridge pillar look like it is completely swallowing the bright red lighthouse.",
    "image": "images/99.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.nycgovparks.org/parks/fort-washington-park/highlights/11053"
  },
  {
    "id": "1788897704351",
    "name": "Survivor Tree",
    "category": "sightseeing",
    "day": "",
    "address": "9/11 Memorial Plaza, 180 Greenwich St, New York, NY 10007",
    "desc": "• Budget 10 to 15 minutes to view this deeply moving, living monument located directly on the 9/11 Memorial plaza.\n• This single Callery pear tree was discovered severely damaged and burned under the rubble of the World Trade Center in October 2001, nursed back to health in the Bronx, and replanted here in 2010.\n• You can clearly see a visible physical boundary line on the trunk where the gnarled, heavily scarred original bark meets the smooth, vibrant new growth. This visual of aggressive regrowth after absolute destruction is profound inspiration for a sacred World Tree or magical forest in The Legend of Valoria that has survived a cataclysmic event.\n• Logistical tip: The plaza is a highly emotional space and is often crowded. Using the 100-400mm lens on your Sony a6600 is perfect here, as it allows you to respectfully capture tight, highly detailed texture shots of the jagged bark and the transition point between the old wood and new branches while standing safely out of the main walking paths.",
    "image": "images/100.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.911memorial.org/visit/memorial/survivor-tree"
  },
  {
    "id": "1788898024590",
    "name": "Economy Candy",
    "category": "shopping",
    "day": "",
    "address": "108 Rivington St, New York, NY 10002",
    "desc": "• Budget 15 to 30 minutes to squeeze through the narrow aisles of the oldest candy store in New York City, operating since 1937.\n• The floor-to-ceiling shelves are absolutely packed with every type of retro, modern, and international treat imaginable, creating a beautifully chaotic explosion of color and clutter.\n• This overwhelming, hyper-dense display of goods is a fantastic real-world reference for drawing a bustling merchant stall, a chaotic bazaar, or a cluttered alchemists shop filled to the brim with colorful potions and strange ingredients in The Legend of Valoria.\n• Logistical tip: The interior of the shop is incredibly cramped and narrow. While the 100-400mm lens on your Sony a6600 will be far too long to capture the whole room, you can use it to shoot highly compressed, abstract detail shots of the stacked sweets, or step outside to capture the classic vintage red awning from down the street.",
    "image": "images/89.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://economycandy.com"
  },
  {
    "id": "1788898664930",
    "name": "1 Dollar Pizza at 300 West 38th Street",
    "category": "dining",
    "day": "",
    "address": "300 W 38th St, New York, NY 10018",
    "desc": "• Budget 10 to 15 minutes to grab a quick, classic New York slice from the chaotic, brightly lit pizza shop occupying the ground floor of this historic corner.\n• This heavily trafficked street-level storefront sits completely at odds with the stunning 1903 Emery Roth Art Nouveau architecture towering directly above it, providing a uniquely jarring New York City contrast.\n• The juxtaposition of a bustling, cheap food stall operating out of the base of an elegant, century-old structure offers perfect conceptual inspiration for a lively tavern or low-end merchant market squatting inside the grand ruins of an ancient kingdom in The Legend of Valoria.\n• Logistical tip: You can step across 8th Avenue with your Sony a6600 and use the 100-400mm lens to heavily compress the bright, garish signage of the pizza shop against the ornate, sculpted stonework just above it, capturing the extreme visual clash in a single cinematic frame.",
    "image": "images/101.jpg",
    "cost": 1,
    "packageId": null,
    "website": ""
  },
  {
    "id": "1788901656901",
    "name": "Mei Lai Wah",
    "category": "dining",
    "day": "",
    "address": "64 Mott St, New York, NY 10013",
    "desc": "• Budget 15 to 30 minutes, primarily to wait in the notoriously fast-moving line for their famous baked and steamed roast pork buns, which have been a neighborhood staple since the 1960s.\n• The frantic energy of the tiny storefront, complete with glowing neon signage, stacked bamboo baskets, and steam pouring out onto the busy sidewalk, creates a highly atmospheric urban scene.\n• This kind of claustrophobic, high-traffic food stall is excellent real-world inspiration for designing a bustling merchant bazaar, a crowded tavern kitchen, or a lively, chaotic street market in The Legend of Valoria.\n• Logistical tip: The streets of Chinatown are deeply layered and densely packed. If you step back down Mott Street, using the 100-400mm lens on your Sony a6600 will let you beautifully compress the overlapping neon shop signs, the heavy foot traffic, and the narrow brick tenements into a single cinematic frame.",
    "image": "images/103.jpg",
    "cost": null,
    "packageId": null,
    "website": ""
  },
  {
    "id": "1788901824295",
    "name": "Physical Graffiti Building",
    "category": "sightseeing",
    "day": "",
    "address": "96 and 98 St Marks Pl, New York, NY 10009",
    "desc": "• Budget 10 to 15 minutes to admire the exterior of these iconic twin tenement buildings, which are globally recognized for being featured on the cover of the legendary 1975 rock album Physical Graffiti.\n• While you are there, you can step down into Physical Graffitea, a cozy tea shop currently operating out of the basement level of the 96 building, to grab a quick drink.\n• The identical stone facades, complete with ornate cornices, heavily textured fire escapes, and deeply recessed windows, offer fantastic architectural reference material for designing dense, multi-level city dwellings or layered guild housing in The Legend of Valoria.\n• Logistical tip: Because the street is narrow and trees often block the wider view from the sidewalk, standing directly across the street and using the 100-400mm lens on your Sony a6600 will let you tightly crop the intricate window details and rusty fire escapes, perfectly isolating the heavy, gritty urban textures from the modern storefronts below.",
    "image": "images/104.jpg",
    "cost": 0,
    "packageId": null,
    "website": ""
  },
  {
    "id": "1788902028258",
    "name": "Kuih Café",
    "category": "dining",
    "day": "",
    "address": "46 Eldridge St, New York, NY 10002",
    "desc": "• Budget 15 to 30 minutes to visit this tiny, family-run spot in Chinatown specializing in traditional, incredibly colorful Malaysian desserts.\n• The shop is famous for their delicate, handcrafted kuih, which are bite-sized treats made with natural ingredients like pandan, ube, and blue pea flower, creating striking visual layers and textures.\n• The meticulous, almost exact-gram precision required to build these vibrant, jewel-toned sweets offers fantastic inspiration for designing magical provisions, rare alchemical ingredients, or exotic marketplace rations in The Legend of Valoria.\n• Logistical tip: The interior is much too small for wide shots, but your Sony a6600 paired with the 100-400mm lens can be used from right outside the door to beautifully isolate and heavily compress the sticky, layered textures and vivid colors of the desserts on display.",
    "image": "images/105.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://kuihcafe.com"
  },
  {
    "id": "1788903102586",
    "name": "New York Cancer Hospital",
    "category": "sightseeing",
    "day": "",
    "address": "455 Central Park West, New York, NY 10025",
    "desc": "• Budget 10 to 15 minutes to view the imposing exterior of this 1880s French chateau-style fortress sitting right on the edge of Central Park.\n• Originally the first hospital in the country dedicated solely to cancer treatment, it was uniquely designed with massive circular stone towers under the 19th-century belief that sharp corners harbored disease and stagnant air.\n• The red brick, heavy brownstone trim, and massive conical slate roofs look exactly like a fortified European keep, making it perfect visual reference material for designing a high-born noble estate in The Legend of Valoria or mapping out circular tower defenses in Stronghold Crusader.\n• Logistical tip: The structure is massive, so standing across the street inside Central Park will give you the best angle. Using the 100-400mm lens on your Sony a6600 from among the park trees will allow you to compress the distance and capture highly detailed shots of the slate roof tiles, arched dormer windows, and heavy stone masonry while completely blocking out the modern traffic below.",
    "image": "images/106.jpg",
    "cost": 0,
    "packageId": null,
    "website": ""
  },
  {
    "id": "1788903524804",
    "name": "Pier 26 Tide Deck",
    "category": "sightseeing",
    "day": "",
    "address": "Pier 26 at Hudson River Park, New York, NY 10013",
    "desc": "• Budget 20 to 30 minutes to walk to the end of Pier 26 and observe this engineered ecological platform, which is specifically designed to flood and empty with the natural tides of the Hudson River.\n• The deck is built with massive boulders and native salt marsh grasses, acting as a miniature, managed coastal habitat right in the middle of Tribeca.\n• Observing the engineered tidal pools and rocky structures flood with the river water offers a unique urban contrast to the natural coastal tidal shifts you navigate while sea angling in the English Channel.\n• The heavy, wet boulders and flooded walkways offer incredible visual references for illustrating rugged coastal fishing villages, tidal floodplains, or dangerous, shifting shorelines in The Legend of Valoria.\n• Logistical tip: You can easily view the deck from the elevated cantilevered walkway directly above it. Pointing the 100-400mm lens on your Sony a6600 straight down allows you to capture highly compressed, textured shots of the jagged rocks and tidal pools while completely cropping out the modern city skyline.",
    "image": "images/107.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://hudsonriverpark.org/locations/pier-26/"
  },
  {
    "id": "1788980763947",
    "name": "Jacob's Pickles",
    "category": "dining",
    "day": "",
    "address": "509 Amsterdam Ave, New York, NY 10024",
    "desc": "• Budget 1 to 2 hours for a heavy, sit-down meal featuring towering fried chicken biscuit sandwiches, macaroni and cheese, and jars of house-made pickles.\n• The sheer volume and caloric density of these plates is a wild departure from strict, exact-gram meal prepping, making it a fantastic and indulgent stop.\n• The interior is decorated with exposed rustic brick, reclaimed wood, and walls lined with glowing glass pickling jars. This aesthetic is incredible real-world inspiration for designing a hearty, bustling travelers inn or an alchemists storage cellar packed with preserved provisions in The Legend of Valoria.\n• Logistical tip: The dining room is usually packed shoulder-to-shoulder with very dim, warm lighting. While the 100-400mm lens on your Sony a6600 will be far too long to capture the whole room, you can use it to shoot highly compressed, tight texture shots of the condensation on the heavy glass mason jars or the rough, towering layers of the biscuit sandwiches to capture that rugged tavern feel.",
    "image": "images/108.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.jacobspickles.com"
  },
  {
    "id": "1788981405898",
    "name": "Brooklyn Heights Promenade",
    "category": "sightseeing",
    "day": "",
    "address": "Pierrepont Pl, Brooklyn, NY 11201",
    "desc": "• Budget 30 to 45 minutes to walk this historic, one-third-mile-long cantilevered walkway elevated above the Brooklyn-Queens Expressway and the East River.\n• The walkway offers arguably the most iconic, unobstructed panoramic view of the lower Manhattan skyline, the Brooklyn Bridge, and the Statue of Liberty.\n• The heavy wrought-iron railings, stone paving, and elevated vantage point overlooking a sprawling coastal metropolis provide excellent reference material for visualizing a grand castle rampart, a walled fortress, or a heavily fortified capital port in The Legend of Valoria.\n• Logistical tip: This is an absolute playground for your Sony a6600 and the 100-400mm lens. Shooting straight across the East River at maximum zoom will drastically compress the distance, making the towering steel and glass skyscrapers of the Financial District look as though they are stacked immediately on top of the ferries and barges navigating the water below.",
    "image": "images/109.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.nycgovparks.org/parks/brooklyn-heights-promenade"
  },
  {
    "id": "1788983946017",
    "name": "New York Stock Exchange",
    "category": "sightseeing",
    "day": "",
    "address": "11 Wall St, New York, NY 10005",
    "desc": "• Budget 10 to 15 minutes to take in the sheer scale of the massive Roman neoclassical facade, complete with its six soaring Corinthian columns and the intricately sculpted marble pediment above.\n• As the historical center of global finance, its fortress-like barricades and intense security presence give it an incredibly imposing, impenetrable atmosphere.\n• The aggressive combination of pristine classical columns heavily fortified by modern steel security barricades provides brilliant visual inspiration for the heavily guarded headquarters of an elite merchant guild or the impenetrable royal treasury in The Legend of Valoria.\n• Logistical tip: The streets of the Financial District are incredibly narrow, making the facade feel massively out of scale with its surroundings. Using the 100-400mm lens on your Sony a6600 from slightly further down Broad Street will allow you to beautifully compress the massive columns against the detailed allegorical sculptures in the pediment, highlighting the intricate texture of the carved stone while easily framing out the dense crowds at street level.",
    "image": "images/111.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.nyse.com"
  },
  {
    "id": "1788984427219",
    "name": "Chrysler Building",
    "category": "skyscrapers",
    "day": "",
    "address": "405 Lexington Ave, New York, NY 10174",
    "desc": "• Budget 15 to 20 minutes to marvel at the gleaming stainless-steel terraced crown and step inside the Moroccan marble lobby of this 1930 Art Deco masterpiece.\n• The ornate, hubcap-inspired friezes, massive metal eagle gargoyles, and sleek geometric motifs create a towering symbol of industrial opulence.\n• These heavily stylized, metallic architectural flourishes are fantastic visual references for an advanced, highly engineered elven spire, an affluent merchants tower, or a majestic monument of a technologically progressing civilization in The Legend of Valoria.\n• Logistical tip: Shooting from directly below on Lexington Avenue will massively distort the proportions. Instead, walk a few blocks away down 42nd Street. Using the 100-400mm lens on your Sony a6600 from a distance will drastically compress the perspective, perfectly isolating the razor-sharp geometric scales of the stainless-steel crown and those famous metallic eagle heads against the sky without the distraction of modern street traffic.",
    "image": "images/112.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://chryslerbuilding.com"
  },
  {
    "id": "1788984571616",
    "name": "Sarge’s Delicatessen & Diner",
    "category": "dining",
    "day": "",
    "address": "548 3rd Ave, New York, NY 10016",
    "desc": "• Budget 45 to 60 minutes to sit in a classic vinyl booth and tackle an absurdly layered pastrami or corned beef sandwich under the glow of vintage Tiffany-style lamps.\n• Much like the massive plates at Jacobs Pickles, the sheer caloric density and chaotic construction of a classic New York deli sandwich is a brilliant, indulgent contrast to strict exact-gram meal prepping.\n• The retro, dimly lit interior packed with hanging meats, neon window signs, and autographed walls offers fantastic atmospheric inspiration for a bustling, round-the-clock adventurers tavern or a chaotic merchant outpost where hearty, oversized rations are served in The Legend of Valoria.\n• Logistical tip: The diner booth seating is tight, but using the 100-400mm lens on your Sony a6600 is perfect for capturing highly compressed, mouth-watering macro shots of the stacked, steaming textures of the carved meat, or you can step outside to tightly crop the iconic, glowing vintage neon sign against the dark Midtown sky.",
    "image": "images/113.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://sargesdeli.com"
  },
  {
    "id": "1788984845098",
    "name": "Burlington",
    "category": "shopping",
    "day": "",
    "address": "4 Union Square S, New York, NY 10003",
    "desc": "• Budget 30 to 45 minutes to brave the sprawling, chaotic aisles of this multi-level discount department store overlooking the bustling Union Square.\n• The sheer volume of merchandise, featuring endless, densely packed racks of clothing and towering shelves of discounted goods, creates an overwhelming, labyrinthine environment fueled by frantic deal-hunting crowds.\n• This overwhelming explosion of varied textiles and disorganized goods offers fantastic real-world inspiration for designing a sprawling, chaotic merchant quarter, a massive textile bazaar, or a crowded guild storehouse overflowing with traveler garments in The Legend of Valoria.\n• Logistical tip: The interior aisles are incredibly tight. While your Sony a6600 and 100-400mm lens cannot capture the full scale of the floor plan, aiming down a long aisle at maximum zoom will radically compress the endless, repeating rows of hanging garments into a dense, abstract wall of fabric and color, perfectly conveying a sense of suffocating inventory.",
    "image": "images/114.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.burlington.com"
  },
  {
    "id": "1788985102194",
    "name": "Trump Tower",
    "category": "sightseeing",
    "day": "",
    "address": "725 5th Ave, New York, NY 10022",
    "desc": "• Budget 15 to 20 minutes to observe the heavily guarded bronze and glass exterior and step into the massive six-story, pink marble public atrium featuring an indoor waterfall.\n• The striking sawtooth facade clad in dark glass, contrasting with the opulent, hyper-reflective golden brass and marble interior, creates a distinct atmosphere of aggressive late-20th-century wealth and power.\n• The imposing interior architecture, complete with its cascading water features and intense security presence, offers excellent conceptual reference for designing the heavily fortified keep of a flamboyant merchant king or an opulent, gold-laden citadel in The Legend of Valoria.\n• Logistical tip: The heavy security barricades and dense 5th Avenue crowds make wide street-level shots extremely difficult. Step across the street and use the 100-400mm lens on your Sony a6600 to look straight up, tightly compressing the sharp, jagged angles of the dark glass facade and the planted terraces to emphasize its fortress-like geometry, entirely removing the street-level chaos from the frame.",
    "image": "images/115.jpg",
    "cost": 0,
    "packageId": null,
    "website": "https://www.trumptowerny.com"
  },
  {
    "id": "1788985397281",
    "name": "Hamburger America",
    "category": "dining",
    "day": "",
    "address": "51 MacDougal St, New York, NY 10012",
    "desc": "• Budget 30 to 45 minutes to grab a seat at this highly stylized, retro diner dedicated to the regional history of the American smash burger, founded by burger historian George Motz.\n• The bright mustard yellow and ketchup red interior, stainless steel countertops, and the constant, intense smoke rising from the flat-top grill create a fiercely energetic and highly specialized dining atmosphere.\n• This hyper-focused, master-craftsman approach to perfecting a single menu item provides excellent conceptual inspiration for a renowned local tavern or a specialized provisions vendor in The Legend of Valoria where travelers gather for a legendary, fiercely guarded recipe.\n• Logistical tip: The diner interior is tight and fast-paced, making wide shots difficult. However, using the 100-400mm lens on your Sony a6600 from across MacDougal Street allows you to shoot directly through the large front windows. You can tightly compress the glowing neon window signage against the frantic movement of the cooks pressing burgers and the rising grill smoke, capturing a highly cinematic slice of urban culinary action.",
    "image": "images/116.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.hamburgeramerica.com"
  },
  {
    "id": "1788985608948",
    "name": "L’Industrie Pizzeria",
    "category": "dining",
    "day": "",
    "address": "254 S 2nd St, Brooklyn, NY 11211",
    "desc": "• Budget 30 to 45 minutes to wait in line for what is widely considered one of the best pizza slices in New York City, blending classic New York style with high-end Italian ingredients.\n• The wildly popular signature slices topped with fresh, bubbling burrata and torn basil are a massive, indulgent departure from your exact-gram meal prep of chickpeas and homemade jerky.\n• The frantic energy of the open kitchen and the sheer demand for their artisan pies offers excellent conceptual inspiration for a highly sought-after bakery in the capital city or a bustling guild kitchen feeding elite warriors in The Legend of Valoria.\n• Logistical tip: The space is highly chaotic, but stepping back across the street and using the 100-400mm lens on your Sony a6600 allows you to shoot through the window and tightly compress the glowing oven fires against the frantic motion of the pizza makers tossing dough.",
    "image": "images/117.jpg",
    "cost": null,
    "packageId": null,
    "website": "http://www.lindustriebk.com"
  },
  {
    "id": "1788986171848",
    "name": "Ace’s Pizza",
    "category": "dining",
    "day": "",
    "address": "637 Driggs Ave, Brooklyn, NY 11211",
    "desc": "• Budget 45 to 60 minutes to sit down and tackle an incredibly thick, caramelized Detroit-style pizza with crispy, burnt cheese edges.\n• The massive caloric density and sheer weight of this square pan pizza is a fantastic, heavy indulgence that completely shatters the strict constraints of exact-gram meal prepping for a barbell weightlifting routine.\n• The retro, wood-paneled interior and arcade-style decor create a distinctly nostalgic urban atmosphere, which serves as great visual reference for a bustling, high-energy tavern or a crowded provisions hall where heavy traveler rations are distributed in The Legend of Valoria.\n• Logistical tip: The interior space has a very specific, glowing retro lighting scheme. Using the 100-400mm lens on your Sony a6600 from outside on Driggs Avenue allows you to shoot through the front glass, aggressively compressing the glowing neon signs against the thick, steaming trays of pizza coming out of the kitchen.",
    "image": "images/118.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.acespizzaspot.com"
  },
  {
    "id": "1788986492671",
    "name": "Bleecker Street Pizza",
    "category": "dining",
    "day": "",
    "address": "69 7th Ave S, New York, NY 10014",
    "desc": "• Budget 20 to 30 minutes to grab a quick, classic New York slice at this iconic corner joint situated at the busy intersection of 7th Avenue South and Bleecker Street.\n• Indulging in their famous Nonna Maria slice, loaded with fresh mozzarella and rich marinara, offers another fantastic, heavy caloric departure from your strict exact-gram meal prep of chickpeas and homemade skyr sauces.\n• The exposed brick exterior and interior walls completely plastered with faded celebrity photos create a distinctly gritty, worn-in urban texture. This chaotic, deeply entrenched neighborhood fixture is brilliant inspiration for a bustling, historic waystation or a crowded market stall where weary travelers gather in The Legend of Valoria.\n• Logistical tip: Because the shop sits on a unique triangular corner, you can stand across the busy intersection and use the 100-400mm lens on your Sony a6600 to heavily compress the glowing neon storefront signage against the historic brick facade, perfectly isolating the kinetic energy of the pizza counter from the heavy traffic of the West Village.",
    "image": "images/119.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://bleeckerstreetpizza.com"
  },
  {
    "id": "1788986701286",
    "name": "Mama’s TOO!",
    "category": "dining",
    "day": "",
    "address": "2750 Broadway, New York, NY 10025",
    "desc": "• Budget 30 to 45 minutes to queue up at this tiny, unassuming storefront that produces some of the most sought-after pizza in the city.\n• The sheer mass and caloric density of these focaccia-style squares provide the ultimate heavy cheat meal, serving as a brilliant, indulgent contrast to your strict exact-gram meal prep and rigid barbell training diet.\n• The massive local demand for such a small, specialized kitchen is fantastic real-world reference for a renowned baker, a fiercely guarded guild provisioner, or a vital food storehouse in Stronghold Crusader translated into the world of The Legend of Valoria.\n• Logistical tip: Broadway is a very wide avenue. By stepping out onto the central pedestrian traffic median and using the 100-400mm lens on your Sony a6600, you can heavily compress the long line of waiting customers directly against the small, glowing storefront, perfectly capturing the intense demand of this tiny culinary outpost.",
    "image": "images/120.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.mamastoo.com"
  },
  {
    "id": "1788986852359",
    "name": "Lil Zeus Lunch Box",
    "category": "dining",
    "day": "",
    "address": "112 W 50th St, New York, NY 10020",
    "desc": "• Budget 30 to 45 minutes, mostly to queue up during the notoriously busy Midtown lunch rush for this highly rated blue food cart.\n• The massive, heavy platters of charred lamb, pork souvlaki, and rice are an incredible high-protein feast that perfectly fuels a heavy barbell weightlifting routine while providing a delicious, chaotic break from your strict exact-gram meal prep.\n• The frantic, fast-paced service and smoky grill of a street-level vendor operating in the shadow of massive skyscrapers provides amazing visual reference for a heavily trafficked traveling merchant cart or a busy provisions stall supplying adventurers in The Legend of Valoria.\n• Logistical tip: The pedestrian traffic here is incredibly dense. Stepping back across 6th Avenue and using the 100-400mm lens on your Sony a6600 lets you sharply compress the thick grill smoke and the bright blue cart against the towering, sterile glass of the Midtown office buildings, perfectly isolating the kinetic street-level merchant energy.",
    "image": "images/121.jpg",
    "cost": null,
    "packageId": null,
    "website": ""
  },
  {
    "id": "1788987000946",
    "name": "Very Fresh Noodles",
    "category": "sightseeing",
    "day": "",
    "address": "75 9th Ave, New York, NY 10011",
    "desc": "• Budget 45 to 60 minutes to navigate the dense crowds of Chelsea Market and wait for a bowl of these heavily spiced, hand-pulled noodles.\n• The massive caloric and carbohydrate payload of the thick dough and rich meat broth is incredible fuel for heavy barbell training, offering another wildly flavorful, chaotic break from the strict confines of exact-gram meal prepping.\n• The kinetic, almost violent energy of watching the cooks stretch and slap the thick dough against the stainless steel counters creates a deeply artisanal atmosphere. This visual of highly skilled, repetitive physical labor is brilliant real-world inspiration for designing a frantic guild kitchen, a steam-filled underground bazaar, or a crowded travelers tavern in The Legend of Valoria.\n• Logistical tip: The interior corridors of Chelsea Market are famously dark, narrow, and heavily textured with exposed brick and industrial piping. By finding a long sightline down the concourse and using the 100-400mm lens on your Sony a6600, you can dramatically compress the dense pedestrian traffic against the glowing storefront and the thick steam rising from the boiling noodle vats, capturing a highly cinematic, claustrophobic market scene.",
    "image": "images/122.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.veryfreshnoodles.com"
  },
  {
    "id": "1788987229154",
    "name": "Ess-a-Bagel",
    "category": "dining",
    "day": "",
    "address": "831 3rd Ave, New York, NY 10022",
    "desc": "• Budget 45 to 60 minutes, heavily factoring in the chaotic morning queue, to secure one of these legendary, oversized New York bagels.\n• The sheer density of these massive carbohydrate and fat bombs provides exceptional fueling for a 4-day barbell lifting split, serving as a wildly indulgent, heavy contrast to your rigid, exact-gram meal prepping of chickpeas and skyr sauces.\n• The frantic, assembly-line efficiency of the counter staff rapidly slicing, smearing, and wrapping heavy provisions is incredible visual reference for a bustling, high-volume guild commissary or a frantic market quarter supplying heavy traveler rations in The Legend of Valoria.\n• Logistical tip: The interior is fiercely crowded and the queue moves aggressively fast. By stepping across 3rd Avenue and utilizing the 100-400mm lens on your Sony a6600, you can compress the frantic morning commuter foot traffic directly against the dense line of hungry customers spilling out the storefront, perfectly capturing the intense kinetic energy of a legendary urban merchant stall.",
    "image": "images/123.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.ess-a-bagel.com"
  },
  {
    "id": "1788987445191",
    "name": "Magnolia Bakery",
    "category": "dining",
    "day": "",
    "address": "401 Bleecker St, New York, NY 10014",
    "desc": "• Budget 20 to 30 minutes to wait in the often-present queue at this historic 1996 corner bakeshop.\n• The incredibly dense, sugar-laden tubs of their legendary banana pudding serve as a massive caloric payload, offering a sweet, heavy cheat-meal contrast to your strict exact-gram meal prepping of chickpeas and skyr.\n• The meticulously swirled pastel frostings and pristine window displays of baked goods offer brilliant visual reference for designing rare, high-society elven provisions or an upscale alchemical sweets vendor in a wealthy capital city in The Legend of Valoria.\n• Logistical tip: The West Village intersection here is highly picturesque. By stepping across Bleecker Street and using the 100-400mm lens on your Sony a6600, you can brilliantly compress the leafy neighborhood tree canopy directly against the vintage shop awning and the warm glow of the bakery window, perfectly isolating a historic slice of urban merchant charm.",
    "image": "images/124.jpg",
    "cost": null,
    "packageId": null,
    "website": "http://www.magnoliabakery.com"
  },
  {
    "id": "1788987757140",
    "name": "Maison Pickle",
    "category": "dining",
    "day": "",
    "address": "2322 Broadway, New York, NY 10024",
    "desc": "• Budget 1.5 to 2 hours for a heavy, sit-down meal at this slightly more refined, yet equally indulgent, sister restaurant to Jacobs Pickles.\n• The sheer caloric weight of their signature carved beef French dip sandwiches and massive, butter-drenched pull-apart bread is an incredible bulking payload for a 4-day barbell split, completely shattering the rules of exact-gram meal prepping.\n• The interior features plush green booths, classic vintage tiling, and an expansive, glowing bar. This opulent, mid-century aesthetic offers fantastic visual inspiration for a wealthy merchant lords dining hall, a high-society guild tavern, or a lavish feast setting in The Legend of Valoria.\n• Logistical tip: The dining room is deep and atmospherically dark. While the 100-400mm lens on your Sony a6600 is too massive to capture the entire room, you can use it to take incredibly tight, textured macro shots of the thick carved beef dripping with hot broth, capturing the rich, heavy reality of opulent tavern provisions for your comic references.",
    "image": "images/125.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.maisonpickle.com"
  },
  {
    "id": "1788987911764",
    "name": "Tony’s Di Napoli",
    "category": "dining",
    "day": "",
    "address": "147 W 43rd St, New York, NY 10036",
    "desc": "• Budget 1.5 to 2 hours for a loud, heavy, sit-down meal featuring absurdly massive platters of chicken parmigiana, baked ziti, and heavy cream sauces designed specifically to be shared.\n• The sheer volume and chaotic nature of these family-style serving troughs serve as an incredible bulking feast for your 4-day barbell lifting routine, providing a wildly indulgent departure from the strict confines of your exact-gram meal prepping.\n• The boisterous, packed dining room filled with large groups passing heavy plates of steaming food provides brilliant visual reference for a chaotic guildhall feast, a crowded travelers inn, or a grand mercenary banquet in The Legend of Valoria.\n• Logistical tip: The interior dining space is vast, warmly lit, and intensely crowded. By stepping outside onto the busy pavement of 43rd Street and using the 100-400mm lens on your Sony a6600, you can shoot through the front glass to heavily compress the bright, frantic neon energy of Times Square directly against the warm, communal feast happening inside, perfectly capturing the intense contrast of the city.",
    "image": "images/126.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.tonysdinapoli.com"
  },
  {
    "id": "1788988145233",
    "name": "Carmine’s – Times Square",
    "category": "sightseeing",
    "day": "",
    "address": "200 W 44th St, New York, NY 10036",
    "desc": "• Budget 1.5 to 2 hours for an incredibly loud, energetic meal where monumental platters of spaghetti and meatballs or chicken scarpariello are dropped onto the center of the table.\n• The overwhelming volume of heavy pasta and rich meats is a massive caloric injection for a 4-day barbell lifting routine, offering a chaotic, delicious break from the strict constraints of exact-gram meal prepping your skyr sauces and jerky.\n• The sprawling, vintage-styled dining room, echoing with the noise of hundreds of people tearing into massive shared provisions, is flawless conceptual inspiration for a grand guildhall feast or a boisterous royal banquet in The Legend of Valoria.\n• Logistical tip: The dining room is immensely vast and constantly moving. Stepping outside the front doors and using the 100-400mm lens on your Sony a6600 lets you capture tight, heavily compressed shots of the glowing Times Square theater marquees directly reflecting off the heavy glass storefront, isolating that frantic theatrical energy without losing the subject in the dense street crowd.",
    "image": "images/127.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://carminesnyc.com/locations/times-square"
  },
  {
    "id": "1788988381088",
    "name": "Texas Roadhouse",
    "category": "dining",
    "day": "",
    "address": "2571 Hempstead Tpke Ste 100, East Meadow, NY 11554",
    "desc": "• Budget 1.5 to 2 hours for a wildly energetic, aggressively loud meal at this rustic, wood-paneled steakhouse located out on Long Island.\n• Tearing into a massive bone-in ribeye and endless baskets of warm rolls with cinnamon butter provides incredible bulking fuel for a 4-day barbell lifting routine, offering a chaotic, high-protein departure from the strict boundaries of exact-gram meal prepping your jerky and chickpeas.\n• The boisterous, dimly lit dining room, packed with heavy wooden booths and echoing with loud music, is brilliant conceptual inspiration for a rowdy frontier tavern, a crowded mercenary outpost, or a bustling hunters guildhall in The Legend of Valoria.\n• Logistical tip: The dining floor is incredibly cramped and intensely active. By stepping out into the sprawling parking lot and using the 100-400mm lens on your Sony a6600, you can tightly compress the bright neon roadhouse signage directly against the frantic, high-speed flow of suburban traffic on Hempstead Turnpike.",
    "image": "images/128.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.texasroadhouse.com"
  },
  {
    "id": "1788988581900",
    "name": "Umi Sushi & Seafood Buffet",
    "category": "sightseeing",
    "day": "",
    "address": "East Meadow, NY 11554",
    "desc": "• Budget 1.5 to 2 hours to fully maximize the all-you-can-eat caloric payload of endless crab legs, fresh sushi rolls, and massive hot food stations.\n• The sheer volume of limitless, high-protein seafood provides incredible bulking fuel for your heavy 4-day barbell lifting routine, serving as a wildly indulgent break from the strict, exact-gram meal prepping of your homemade jerky and skyr sauces.\n• The sprawling dining hall, packed with fiercely competitive patrons harvesting towering plates of provisions, is brilliant conceptual inspiration for a massive coastal guildhall feast, an affluent oceanic merchant market, or a bustling seaside tavern in The Legend of Valoria.\n• Logistical tip: The interior dining space is immensely vast and constantly moving. While the 100-400mm lens on your Sony a6600 is too tight for a wide room shot, you can position yourself at the far end of the long buffet line and heavily compress the glowing, steaming trays of food directly against the frantic motion of the kitchen staff rapidly replenishing the stations.",
    "image": "images/129.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.umibuffet.com"
  },
  {
    "id": "1788989148879",
    "name": "Flaming Grill & Supreme Buffet",
    "category": "dining",
    "day": "",
    "address": "East Meadow, NY 11554",
    "desc": "• Budget 1.5 to 2 hours to fully maximize the all-you-can-eat caloric payload of endless crab legs, fresh sushi rolls, and massive hot food stations.\n• The sheer volume of limitless, high-protein seafood provides incredible bulking fuel for your heavy 4-day barbell lifting routine, serving as a wildly indulgent break from the strict, exact-gram meal prepping of your homemade jerky and skyr sauces.\n• The sprawling dining hall, packed with fiercely competitive patrons harvesting towering plates of provisions, is brilliant conceptual inspiration for a massive coastal guildhall feast, an affluent oceanic merchant market, or a bustling seaside tavern in The Legend of Valoria.\n• Logistical tip: The interior dining space is immensely vast and constantly moving. While the 100-400mm lens on your Sony a6600 is too tight for a wide room shot, you can position yourself at the far end of the long buffet line and heavily compress the glowing, steaming trays of food directly against the frantic motion of the kitchen staff rapidly replenishing the stations.",
    "image": "images/130.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.umibuffet.com"
  },
  {
    "id": "1789064877380",
    "name": "K-CITY BBQ Hot Pot & Sushi",
    "category": "dining",
    "day": "",
    "address": "3056 Hempstead Tpke, Levittown, NY 11756",
    "desc": "• Budget 1.5 to 2 hours for an aggressively interactive, all-you-can-eat meal where you cook endless plates of raw ingredients on tabletop grills and in simmering broths.\n• The massive volume of unlimited grilled meats, sushi, and seafood is the ultimate bulking payload for your heavy 4-day barbell split, completely obliterating the strict constraints of exact-gram meal prepping your homemade jerky and skyr sauces.\n• The kinetic, smoke-filled dining room, packed with patrons crowded around glowing embers and boiling pots, provides incredible conceptual reference for an active alchemical kitchen, a boisterous guildhall hearth, or a smoky tavern where travelers cook their own heavy rations in The Legend of Valoria.\n• Logistical tip: The dining room is heavily obscured by cooking exhaust. By shooting across the bustling tables with the 100-400mm lens on your Sony a6600, you can aggressively compress the thick, rising steam directly against the glowing orange heat of the grills, capturing a highly cinematic, fiery atmosphere while completely blurring out the background chaos.",
    "image": "images/131.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.kcitybbq.com"
  },
  {
    "id": "1789065190867",
    "name": "The Monster Crab",
    "category": "dining",
    "day": "",
    "address": "242 Voice Rd, Carle Place, NY 11514",
    "desc": "• Budget 1.5 to 2 hours for a wildly messy, intensely hands-on meal where you will be cracking open massive piles of buttery, heavily spiced crab legs, shrimp, and mussels.\n• This overwhelming volume of high-protein maritime provisions is an absolute powerhouse for fueling your 4-day barbell lifting routine, offering a chaotic, primal departure from the strict boundaries of exact-gram meal prepping your homemade jerky and skyr sauces.\n• The kinetic, fiercely communal process of cracking shells and tearing into seasoned seafood provides flawless visual reference for a rowdy dockside tavern, a crowded coastal merchant enclave, or a bustling seaside stronghold in The Legend of Valoria where travelers feast on fresh catches.\n• Logistical tip: The tables become instantly crowded with massive piles of shells and steaming bags of food. By leaning back in your booth and using the 100-400mm lens on your Sony a6600, you can capture incredibly tight, highly textured macro shots of the bright red, spice-covered crab legs dripping with butter, perfectly isolating the rich, heavy reality of the coastal feast while blurring out the plastic bibs and messy tabletop.",
    "image": "images/132.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://themonstercrab.com"
  },
  {
    "id": "1789065455629",
    "name": "Cinnabar",
    "category": "dining",
    "day": "",
    "address": "45 Carmans Rd, Massapequa, NY 11758",
    "desc": "• Budget 1.5 to 2 hours for a leisurely, all-you-can-eat sushi feast in a sleek, dimly lit lounge that blends traditional Chinese aesthetics with modern flair.\n• The massive volume of limitless, high-protein sushi rolls and sashimi is an incredible bulking payload for your heavy 4-day barbell lifting routine, offering a vibrant, indulgent departure from the strict boundaries of exact-gram meal prepping your homemade jerky and chickpeas.\n• The opulent, deeply atmospheric dining room, featuring rich colors, soft red lighting, and polished wood, provides flawless visual reference for an exclusive merchant guildhall, a wealthy alchemical tea house, or a luxurious coastal tavern in The Legend of Valoria where elite travelers gather.\n• Logistical tip: The interior is beautifully, yet very darkly, lit with striking red accents. By using the 100-400mm lens on your Sony a6600, you can shoot incredibly tight, highly compressed macro shots of the meticulously crafted, colorful sushi rolls resting on the dark wooden tables, perfectly isolating the vibrant textures of the fresh fish while blurring out the dim, moody background.",
    "image": "images/133.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.cinnabarsushi.com"
  },
  {
    "id": "1789065590540",
    "name": "Sexy Crab Cajun Seafood, Sushi & Bar",
    "category": "dining",
    "day": "",
    "address": "3267 Hempstead Tpke, Levittown, NY 11756",
    "desc": "• Budget 1.5 to 2 hours for a wildly chaotic, high-energy dining experience that aggressively combines overflowing bags of spicy Cajun seafood boils with massive sushi platters.\n• The massive volume of all-you-can-eat crab legs, shrimp, and fresh fish is an absolute powerhouse for fueling your heavy 4-day barbell lifting routine, offering a primal, highly indulgent departure from the strict boundaries of exact-gram meal prepping your homemade jerky and skyr sauces.\n• The kinetic, brightly lit dining room, packed with patrons aggressively cracking shells and passing massive platters, provides flawless visual reference for a rowdy dockside tavern, a crowded coastal merchant enclave, or a bustling seaside stronghold in The Legend of Valoria where travelers feast on exotic maritime provisions.\n• Logistical tip: The tables become instantly crowded with massive piles of discarded shells, steaming plastic bags of food, and long sushi boats. By leaning back in your booth and using the 100-400mm lens on your Sony a6600, you can capture incredibly tight, highly textured macro shots of the bright red, spice-covered crab legs directly juxtaposed against the precise, colorful construction of the sushi rolls, perfectly isolating the rich reality of the coastal feast while blurring out the plastic bibs and messy tabletop.",
    "image": "images/134.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.sexycrabny.com"
  },
  {
    "id": "1789065750254",
    "name": "Culture Espresso",
    "category": "dining",
    "day": "",
    "address": "72 W 38th St, New York, NY 10018",
    "desc": "• Budget 15 to 20 minutes to grab an expertly pulled cortado and one of their legendary, massive chocolate chip cookies.\n• The sheer caloric weight and sugar density of these thick, gooey cookies provide a phenomenal bulking payload to fuel a heavy 4-day barbell lifting routine, serving as a brilliant, indulgent contrast to the rigid constraints of exact-gram meal prepping your homemade jerky and chickpeas.\n• The frantic, highly specialized workflow of the baristas inside this tiny, art-adorned coffeehouse provides excellent conceptual reference for a renowned alchemical brewer or an elite guild baker operating a cramped, highly sought-after merchant stall in The Legend of Valoria.\n• Logistical tip: The interior is famously tiny and constantly packed with commuters. Instead of trying to maneuver inside, step out onto the busy pavement of 38th Street and use the 100-400mm lens on your Sony a6600 to shoot through the front glass. You can beautifully compress the warm, glowing stacks of fresh cookies and the rising steam of the espresso machine directly against the cold, frantic reality of the street-level foot traffic.",
    "image": "images/135.jpg",
    "cost": null,
    "packageId": null,
    "website": "http://www.cultureespresso.com"
  },
  {
    "id": "1789066021788",
    "name": "Liberty Bagels",
    "category": "sightseeing",
    "day": "",
    "address": "260 W 35th St, New York, NY 10001",
    "desc": "• Budget 30 to 45 minutes to brave the intense morning queue and secure one of their legendary, aggressively stuffed bagel sandwiches.\n• The sheer density of these colossal carbohydrates, heavily laden with thick slabs of lox and whipped cream cheese, offers an incredible bulking payload for a heavy 4-day barbell split, acting as a wildly indulgent break from your rigid exact-gram meal prepping of homemade jerky and chickpeas.\n• The massive display cases featuring vibrant, multi-colored rainbow bagels and towering tubs of assorted spreads offer fantastic visual reference for an eccentric alchemical sweets vendor, a highly sought-after merchant stall at a royal festival, or a bustling guild bakery in The Legend of Valoria.\n• Logistical tip: The interior is brightly lit but intensely crowded. Step back towards the entrance and use the 100-400mm lens on your Sony a6600 to heavily compress the towering, colorful stacks of fresh bagels directly against the frantic, fast-paced motion of the staff rapidly wrapping heavy provisions, perfectly isolating the kinetic energy of a renowned urban market stall.",
    "image": "images/136.jpg",
    "cost": null,
    "packageId": null,
    "website": "https://www.libertybagelsnyc.com"
  }
];

  const SAMPLE_PACKAGES = [
  {
    "id": "pkg-1788129485954n4a8xunrpce",
    "name": "Statue City Cruises",
    "cost": 26
  }
];

  /* ============ Storage: trips index ============ */
  async function loadTripsIndex() {
    try {
      const res = await window.storage.get(TRIPS_INDEX_KEY);
      if (res && res.value) {
        const parsed = JSON.parse(res.value);
        if (Array.isArray(parsed) && parsed.length > 0) { trips = parsed; return; }
      }
    } catch (e) { /* none yet */ }
    trips = [{ id: 'trip-default', name: 'NY & Long Island', shared: false }];
    await persistTripsIndex();
  }

  async function persistTripsIndex() {
    try { await window.storage.set(TRIPS_INDEX_KEY, JSON.stringify(trips)); } catch (e) { /* ignore */ }
  }

  function currentTrip() { return trips.find(t => t.id === currentTripId); }
  function tripPlacesKey(tripId) { return `trip-places:${tripId}`; }

  /* ============ Storage: places for current trip ============ */
  async function loadCurrentTripPlaces() {
    isLoading = true;
    renderPlaces();
    const trip = currentTrip();
    try {
      const res = await window.storage.get(tripPlacesKey(trip.id), !!trip.shared);
      if (res && res.value) {
        const parsed = JSON.parse(res.value);
        if (Array.isArray(parsed)) { places = parsed; packages = []; }
        else { places = Array.isArray(parsed.places) ? parsed.places : []; packages = Array.isArray(parsed.packages) ? parsed.packages : []; }
      } else {
        places = trip.id === 'trip-default' ? JSON.parse(JSON.stringify(SAMPLE_PLACES)) : [];
        packages = trip.id === 'trip-default' ? JSON.parse(JSON.stringify(SAMPLE_PACKAGES)) : [];
        await persistPlaces();
      }
    } catch (e) {
      places = trip.id === 'trip-default' ? JSON.parse(JSON.stringify(SAMPLE_PLACES)) : [];
      packages = trip.id === 'trip-default' ? JSON.parse(JSON.stringify(SAMPLE_PACKAGES)) : [];
      await persistPlaces();
    }
    isLoading = false;
    populatePackageSelect();
    renderPlaces();
  }

  async function persistPlaces() {
    const trip = currentTrip();
    if (!trip) return;
    const indicator = document.getElementById('saveIndicator');
    const text = document.getElementById('saveText');
    indicator.classList.add('saving');
    text.textContent = 'Saving...';
    try {
      await window.storage.set(tripPlacesKey(trip.id), JSON.stringify({ places, packages }), !!trip.shared);
      text.textContent = 'Saved';
    } catch (e) {
      text.textContent = 'Save failed';
    }
    setTimeout(() => indicator.classList.remove('saving'), 600);
    updateBudgetTotal();
  }

  /* ============ Trip management ============ */
  function renderTripSelect() {
    const select = document.getElementById('tripSelect');
    select.innerHTML = trips.map(t => `<option value="${t.id}" ${t.id === currentTripId ? 'selected' : ''}>${escapeHtml(t.name)}${t.shared ? ' (shared)' : ''}</option>`).join('');
    document.getElementById('tripHeading').textContent = currentTrip() ? currentTrip().name : 'Trip itinerary';
    document.getElementById('sharedToggle').checked = !!currentTrip()?.shared;
    document.getElementById('sharedBadge').classList.toggle('show', !!currentTrip()?.shared);
  }

  document.getElementById('tripSelect').addEventListener('change', async (e) => {
    currentTripId = e.target.value;
    renderTripSelect();
    await loadCurrentTripPlaces();
  });

  async function createTrip() {
    const name = window.prompt('Name this trip:', 'New trip');
    if (!name || !name.trim()) return;
    const id = 'trip-' + Date.now();
    trips.push({ id, name: name.trim(), shared: false });
    await persistTripsIndex();
    currentTripId = id;
    places = [];
    packages = [];
    await persistPlaces();
    renderTripSelect();
    renderPlaces();
    showToast('Trip created');
  }

  async function renameTrip() {
    const trip = currentTrip();
    if (!trip) return;
    const name = window.prompt('Rename trip:', trip.name);
    if (!name || !name.trim()) return;
    trip.name = name.trim();
    await persistTripsIndex();
    renderTripSelect();
  }

  async function deleteTrip() {
    if (trips.length <= 1) { showToast("Can't delete your only trip"); return; }
    const trip = currentTrip();
    if (!window.confirm(`Delete "${trip.name}" and all its stops? This can't be undone.`)) return;
    try { await window.storage.delete(tripPlacesKey(trip.id), !!trip.shared); } catch (e) { /* ignore */ }
    trips = trips.filter(t => t.id !== trip.id);
    await persistTripsIndex();
    currentTripId = trips[0].id;
    renderTripSelect();
    await loadCurrentTripPlaces();
    showToast('Trip deleted');
  }

  async function toggleShared() {
    const trip = currentTrip();
    const checkbox = document.getElementById('sharedToggle');
    if (checkbox.checked) {
      const ok = window.confirm('Shared trips are visible to everyone using this app, not just you. Continue?');
      if (!ok) { checkbox.checked = false; return; }
      trip.shared = true;
    } else {
      trip.shared = false;
    }
    await persistTripsIndex();
    await persistPlaces();
    renderTripSelect();
    showToast(trip.shared ? 'Trip is now shared' : 'Trip is now private');
  }

  async function clearAllStops() {
    if (places.length === 0) return;
    if (!window.confirm('Remove all stops from this trip?')) return;
    undoSnapshot = JSON.stringify(places);
    places = [];
    renderPlaces();
    await persistPlaces();
    showUndoToast('All stops cleared');
  }

  async function resetToSample() {
    if (!window.confirm('Replace this trip\'s stops with the sample itinerary?')) return;
    undoSnapshot = JSON.stringify(places);
    undoPackagesSnapshot = JSON.stringify(packages);
    places = JSON.parse(JSON.stringify(SAMPLE_PLACES)).map(p => ({ ...p, id: Date.now().toString() + Math.random().toString(36).slice(2) }));
    packages = JSON.parse(JSON.stringify(SAMPLE_PACKAGES));
    renderPlaces();
    await persistPlaces();
    showUndoToast('Reset to sample trip');
  }

  /* ============ Export / Import ============ */
  function exportJson() {
    const trip = currentTrip();
    const data = { tripName: trip.name, exportedAt: new Date().toISOString(), places, packages };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${trip.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Itinerary exported');
  }

  function importJson(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(reader.result);
        const importedPlaces = Array.isArray(parsed) ? parsed : parsed.places;
        const importedPackages = Array.isArray(parsed) ? [] : (Array.isArray(parsed.packages) ? parsed.packages : []);
        if (!Array.isArray(importedPlaces)) throw new Error('bad shape');
        if (!window.confirm(`Import ${importedPlaces.length} stop(s)? This will replace the current trip's stops.`)) return;
        undoSnapshot = JSON.stringify(places);
        undoPackagesSnapshot = JSON.stringify(packages);
        places = importedPlaces;
        packages = importedPackages;
        renderPlaces();
        await persistPlaces();
        populatePackageSelect();
        showUndoToast('Itinerary imported');
      } catch (e) {
        showToast('Could not read that file');
      }
      event.target.value = '';
    };
    reader.readAsText(file);
  }

  /* ============ Description rendering (tip cards, line breaks) ============ */
  // Small monochrome icons (currentColor) used to badge each tip card and
  // the Insider Hack / Good to know callouts, keyed by a short name so the
  // category-detection logic below can just say "this tip gets the clock".
  const TIP_ICONS = {
    ticket: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1.5a1.5 1.5 0 0 0 0 3V15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1.5a1.5 1.5 0 0 0 0-3V9z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 8v8" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2 2"/></svg>',
    clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M12 7v5l3.5 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    camera: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1-1.6A1.5 1.5 0 0 1 10 4.6h4a1.5 1.5 0 0 1 1.3.8l1 1.6h2.2A1.5 1.5 0 0 1 20 8.5V17a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17V8.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="12.5" r="3.2" stroke="currentColor" stroke-width="1.6"/></svg>',
    shield: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 3l7 3v5c0 5-3.2 8.4-7 10-3.8-1.6-7-5-7-10V6l7-3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    stairs: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 20v-4h4v-4h4V8h4V4h4" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    bulb: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.45 1 .9 1.1 1.6h4.8c.1-.7.5-1.15 1.1-1.6A6 6 0 0 0 12 3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    star: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 3.5l2.5 5.3 5.8.8-4.2 4.1 1 5.8-5.1-2.7-5.1 2.7 1-5.8-4.2-4.1 5.8-.8L12 3.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    coin: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M12 7v10M9.5 9.3c0-1.2 1.1-2 2.5-2s2.5.8 2.5 1.8c0 2.4-5 1.4-5 3.8 0 1 1.1 1.9 2.5 1.9s2.5-.8 2.5-1.9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    pin: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 21s7-7.5 7-12a7 7 0 1 0-14 0c0 4.5 7 12 7 12z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="9" r="2.2" stroke="currentColor" stroke-width="1.8"/></svg>'
  };

  // Keyword-based categorization, reused for (a) picking each tip card's
  // icon/color and (b) grouping cards under subheadings once a place has
  // more than 8 tips. Not a real taxonomy — a tip with no keyword match
  // falls back to the neutral "Good to know" bucket rather than being
  // mis-sorted into an unrelated one.
  const TIP_ICON_CATEGORIES = [
    { name: 'Tickets & Booking', iconKey: 'ticket', cssKey: 'ticket', keywords: ['ticket', 'book', 'reservation', 'reserve', 'admission', 'advance', 'pass', 'entry'] },
    { name: 'Logistics & Timing', iconKey: 'clock', cssKey: 'timing', keywords: ['budget', 'hour', 'minute', 'early', 'arrive', 'schedule', 'queue', 'line', 'crowd', 'weekday', 'weekend', 'morning', 'evening', 'time slot'] },
    { name: 'Photography', iconKey: 'camera', cssKey: 'photo', keywords: ['photo', 'camera', 'view', 'angle', 'picture', 'glass', 'skyline', 'composition', 'shot'] },
    { name: 'Rules & Safety', iconKey: 'shield', cssKey: 'safety', keywords: ['security', 'bag', 'prohibit', 'screening', ' id', 'wristband', 'locker', 'allowed', 'strict'] },
    { name: 'Getting Around', iconKey: 'stairs', cssKey: 'stairs', keywords: ['stairs', 'steps', 'climb', 'elevator', 'narrow', 'flight'] }
  ];
  const DEFAULT_TIP_CATEGORY = { name: 'Good to know', iconKey: 'bulb', cssKey: 'default' };

  function detectTipCategory(text) {
    const lower = text.toLowerCase();
    let best = null, bestScore = 0;
    TIP_ICON_CATEGORIES.forEach(cat => {
      const score = cat.keywords.reduce((n, kw) => n + (lower.includes(kw) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; best = cat; }
    });
    return best || DEFAULT_TIP_CATEGORY;
  }

  const BULLET_RE = /^[-*•]\s+/;
  const NUM_RE = /^\d+[.)]\s+/;
  const stripMarker = l => l.replace(BULLET_RE, '').replace(NUM_RE, '');

  // Breaks a raw tips-and-tricks string into "chunks" — either a
  // heading+body paragraph (a short first line followed by body lines) or
  // a single sentence (a lone bullet, or a stray line with no blank-line
  // neighbors). Each chunk still needs a title before it can become a card.
  function splitIntoTipChunks(desc) {
    const blocks = [];
    let current = [];
    for (const raw of desc.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '') { if (current.length) { blocks.push(current); current = []; } }
      else current.push(line);
    }
    if (current.length) blocks.push(current);

    const chunks = [];
    blocks.forEach(blockLines => {
      const allBullets = blockLines.every(l => BULLET_RE.test(l) || NUM_RE.test(l));
      if (allBullets) {
        blockLines.forEach(l => chunks.push(stripMarker(l)));
      } else if (blockLines.length > 1) {
        chunks.push({ title: stripMarker(blockLines[0]), body: blockLines.slice(1).map(stripMarker).join(' ') });
      } else {
        chunks.push(stripMarker(blockLines[0]));
      }
    });
    return chunks;
  }

  // Most tips in this app are a single free-form sentence with no
  // separate heading ("Book a 'Reserve' ticket to skip lines and arrive
  // 45-60 minutes early..."), so a short title is synthesized by cutting
  // at the first natural break (comma/semicolon) or, failing that, the
  // first handful of words — then Title Cased.
  function extractTipTitle(text) {
    const clean = text.trim();
    const breakMatch = clean.match(/^(.{8,55}?)[,;]\s+([\s\S]*)$/);
    let titlePart, bodyPart;
    if (breakMatch) { titlePart = breakMatch[1]; bodyPart = breakMatch[2]; }
    else {
      const words = clean.split(/\s+/);
      const take = Math.min(6, words.length);
      titlePart = words.slice(0, take).join(' ');
      bodyPart = words.slice(take).join(' ');
    }
    titlePart = titlePart.replace(/^["“]|["”]$/g, '').replace(/[.:,;]+$/, '').trim();
    const smallWords = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'at', 'by', 'with', 'is', 'are']);
    const title = titlePart.split(' ').filter(Boolean).map((w, i) => {
      const lw = w.toLowerCase();
      return (i > 0 && smallWords.has(lw)) ? lw : w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
    return { title: title || clean.slice(0, 40), body: (bodyPart || clean).trim() };
  }

  function normalizeChunk(chunk) {
    if (typeof chunk === 'object') {
      return { title: chunk.title, body: chunk.body, raw: chunk.title ? `${chunk.title}. ${chunk.body}` : chunk.body };
    }
    const { title, body } = extractTipTitle(chunk);
    return { title, body, raw: chunk };
  }

  // Pulls out (at most) one "Insider Hack" and one "Good to know" item to
  // feature in the callout footer, using the tip's own wording rather than
  // inventing new copy. Many entries already contain an explicit
  // "Logistical tip:" line — that's the most reliable "good to know"
  // signal — while a budget/advance-booking tip makes a solid "hack".
  // Both picks are removed from the main grid so nothing is shown twice.
  function pickCallouts(items) {
    const goodIdx = items.findIndex(it => /^logistical tip:?/i.test(it.raw.trim()));
    const hackIdx = items.findIndex((it, i) => i !== goodIdx && /budget|arrive early|book[^.]{0,40}advance|reserve[^.]{0,40}advance|\bin advance\b|allow[^.]{0,25}(hour|minute)/i.test(it.raw));
    const good = goodIdx !== -1 ? items[goodIdx].raw.replace(/^logistical tip:?\s*/i, '').trim() : null;
    const hack = hackIdx !== -1 ? items[hackIdx].raw.trim() : null;
    const skip = new Set([goodIdx, hackIdx].filter(i => i !== -1));
    const remaining = items.filter((_, i) => !skip.has(i));
    return { good, hack, remaining };
  }

  // Six colors, cycled by the card's position in the grid so a row of tips
  // reads as a lively, varied palette (blue/red/green/yellow/purple/teal) —
  // matching the reference design — rather than every card defaulting to
  // whichever single category color happens to match most often. The icon
  // *glyph* still comes from detectTipCategory (so it stays content-aware);
  // only the background/foreground color is decoupled and position-based.
  const TIP_COLOR_CYCLE = ['ticket', 'safety', 'timing', 'bag', 'photo', 'stairs'];

  function buildTipCardHtml(item, index) {
    const cat = detectTipCategory(`${item.title} ${item.body}`);
    const iconSvg = TIP_ICONS[cat.iconKey] || TIP_ICONS.bulb;
    const colorKey = TIP_COLOR_CYCLE[(index || 0) % TIP_COLOR_CYCLE.length];
    return `<div class="tip-card tip-card-titled">
      <span class="tip-card-icon tip-icon-${colorKey}">${iconSvg}</span>
      <div class="tip-card-text">
        <p class="tip-card-title">${escapeHtml(item.title)}</p>
        ${item.body ? `<p class="tip-card-body">${escapeHtml(item.body)}</p>` : ''}
      </div>
    </div>`;
  }

  function buildCalloutsHtml(hack, good) {
    if (!hack && !good) return '';
    if (hack && good) {
      return `<div class="detail-callouts">
        <div class="detail-callout"><span class="detail-callout-icon">${TIP_ICONS.star}</span><div><div class="detail-callout-label">Insider hack</div><div class="detail-callout-text">${escapeHtml(hack)}</div></div></div>
        <div class="detail-callout"><span class="detail-callout-icon">${TIP_ICONS.shield}</span><div><div class="detail-callout-label">Good to know</div><div class="detail-callout-text">${escapeHtml(good)}</div></div></div>
      </div>`;
    }
    const only = hack || good;
    const label = hack ? 'Insider hack' : 'Good to know';
    const icon = hack ? TIP_ICONS.star : TIP_ICONS.shield;
    return `<div class="detail-callouts" style="grid-template-columns:1fr;">
      <div class="detail-callout"><span class="detail-callout-icon">${icon}</span><div><div class="detail-callout-label">${label}</div><div class="detail-callout-text">${escapeHtml(only)}</div></div></div>
    </div>`;
  }

  // Renders a place's free-form "Tips & Tricks" text as icon-badged cards.
  // Always escapes first — never trust raw text.
  function renderDescHtml(desc) {
    if (!desc) return '';
    const chunks = splitIntoTipChunks(desc);
    if (chunks.length === 0) return '';
    const items = chunks.map(normalizeChunk).filter(it => it.title || it.body);
    if (items.length === 0) return '';

    return `<div class="tip-cards">${items.map((item, i) => buildTipCardHtml(item, i)).join('')}</div>`;
  }

  // Cards show the short description (what the place IS), never a tip —
  // tips/tricks live in `desc` and only surface in the detail modal once
  // someone taps "View insider tips". If no description has been entered yet,
  // fall back to a neutral prompt rather than silently pulling in a tip.
  function getCardBlurb(place) {
    return (place.summary || '').trim();
  }

  /* ============ Helpers ============ */
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // Adds a https:// scheme to a bare domain (e.g. "nps.gov/stli" ->
  // "https://nps.gov/stli") so the link works even if the user typed the
  // website without one. Returns null if there's nothing to link to.
  function normalizeWebsiteUrl(raw) {
    const t = (raw || '').trim();
    if (!t) return null;
    return /^https?:\/\//i.test(t) ? t : `https://${t}`;
  }

  /* ============ Location coordinates (for reliable Citymapper deep links) ============ */
  // Citymapper's own docs are explicit: `endcoord` (lat,lng) is the one
  // required parameter — `endaddress` alone doesn't tell it where to go.
  // This app runs inside a Claude.ai artifact, and artifacts run in a
  // sandboxed iframe that blocks fetch() to arbitrary third-party domains
  // (like a geocoding API), so we can't resolve coordinates over the
  // network. Instead: if the address field contains a Google Maps link
  // (Share -> Copy link on a place), we pull the lat/lng straight out of
  // the URL itself — that's pure string parsing, no network call needed.
  //
  // Works with links like:
  //   https://www.google.com/maps/place/Statue+of+Liberty/@40.6892,-74.0445,17z/data=...!3d40.6892494!4d-74.0445004...
  //   https://www.google.com/maps?q=40.6892,-74.0445
  // Does NOT work with shortened links (maps.app.goo.gl/...) since those
  // only reveal real coordinates after a server redirect we can't follow.
  function parseGoogleMapsLink(text) {
    const t = (text || '').trim();
    if (!/^https?:\/\//i.test(t) || !/google\.[a-z.]+\/maps|maps\.google\./i.test(t)) return null;
    if (/maps\.app\.goo\.gl|goo\.gl\/maps/i.test(t)) {
      return { shortened: true };
    }
    // Prefer the precise pin coords (!3d<lat>!4d<lng>) over the map's
    // camera-center coords (@<lat>,<lng>) since the latter can drift once
    // you've panned/zoomed before copying the link.
    let m = t.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (!m) m = t.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (!m) m = t.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (!m) return null;
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    let name = null;
    const nameMatch = t.match(/\/maps\/place\/([^/]+)\//);
    if (nameMatch) { try { name = decodeURIComponent(nameMatch[1].replace(/\+/g, ' ')); } catch (e) { /* leave null */ } }
    return { lat, lng, name };
  }

  // Live-formats the address field as the user pastes: if it's a full
  // Google Maps link, swap it for a clean address/name and remember the
  // coordinates on the form (read back in submitForm) instead of storing
  // the raw URL as the "address".
  let pendingCoords = null; // {lat,lng} captured from the last pasted Maps link, consumed on submit

  /* ============ Gallery photo inputs (form) ============ */
  // Extra photo URLs for the stop being added/edited, beyond the single
  // "Cover photo". Rendered as small removable thumbnails; collected into
  // place.gallery on submit.
  let galleryUrls = [];

  function renderGalleryInputs() {
    const list = document.getElementById('galleryInputList');
    if (!list) return;
    list.innerHTML = galleryUrls.map((url, i) => `
      <div class="gallery-input-item">
        <img src="${escapeHtml(url)}" alt="Gallery photo ${i + 1}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
        <div class="gallery-input-broken" style="display:none;">Broken image</div>
        <button type="button" class="gallery-input-remove" onclick="removeGalleryInput(${i})" title="Remove photo" aria-label="Remove photo ${i + 1}">×</button>
      </div>
    `).join('');
  }

  function addGalleryUrls() {
    const ta = document.getElementById('galleryUrlInput');
    if (!ta) return;
    const urls = ta.value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    if (urls.length === 0) return;
    galleryUrls.push(...urls);
    ta.value = '';
    renderGalleryInputs();
  }

  function handleGalleryInputKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      addGalleryUrls();
    }
  }

  function removeGalleryInput(index) {
    galleryUrls.splice(index, 1);
    renderGalleryInputs();
  }
  function handleAddressPaste() {
    const input = document.getElementById('placeAddress');
    const parsed = parseGoogleMapsLink(input.value);
    if (!parsed) { pendingCoords = null; return; }
    if (parsed.shortened) {
      showToast("Shortened Maps links don't carry coordinates — use the full google.com/maps link instead");
      pendingCoords = null;
      return;
    }
    pendingCoords = { lat: parsed.lat, lng: parsed.lng };
    if (parsed.name) input.value = parsed.name;
    showToast('Exact location captured from Google Maps link');
  }

  // Builds a Citymapper directions URL, using real coordinates when we
  // have them (far more reliable) and falling back to the address alone.
  function buildCitymapperUrl(place) {
    if (!place || !place.address) return null;
    const params = new URLSearchParams();
    params.set('endaddress', place.address);
    params.set('endname', place.name);
    if (place.lat != null && place.lng != null) params.set('endcoord', `${place.lat},${place.lng}`);
    return `https://citymapper.com/directions?${params.toString()}`;
  }

  // Citymapper's website is really a mobile companion to their app — on
  // desktop (no app installed) it renders a blank shell with no pin, even
  // with a fully correct URL. So we only show the Citymapper button on
  // phones/tablets, where it can actually open the app or a working mobile
  // web map; desktop users get Google Maps only.
  function isMobileDevice() {
    return /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent || '');
  }

  function getVisiblePlaces() {
    let list = currentFilter === 'all' ? places : places.filter(p => p.category === currentFilter);
    const q = document.getElementById('searchInput').value.trim().toLowerCase();
    if (q) {
      list = list.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.summary || '').toLowerCase().includes(q) ||
        (p.desc || '').toLowerCase().includes(q) ||
        (p.address || '').toLowerCase().includes(q)
      );
    }
    return list;
  }

  function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.innerHTML = escapeHtml(msg);
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2200);
  }

  function showUndoToast(msg) {
    const toast = document.getElementById('toast');
    toast.innerHTML = `${escapeHtml(msg)} <button onclick="performUndo()">Undo</button>`;
    toast.classList.add('show');
    setTimeout(() => { if (toast.classList.contains('show')) { toast.classList.remove('show'); undoSnapshot = null; } }, 5000);
  }

  async function performUndo() {
    if (!undoSnapshot) return;
    places = JSON.parse(undoSnapshot);
    undoSnapshot = null;
    if (undoPackagesSnapshot) {
      packages = JSON.parse(undoPackagesSnapshot);
      undoPackagesSnapshot = null;
      populatePackageSelect();
    }
    document.getElementById('toast').classList.remove('show');
    renderPlaces();
    await persistPlaces();
    announce('Change undone');
  }

  function announce(msg) {
    document.getElementById('liveRegion').textContent = msg;
  }

  function updateBudgetTotal() {
    const usedPackageIds = new Set(places.filter(p => p.packageId).map(p => p.packageId));
    const individualTotal = places.reduce((sum, p) => sum + (p.packageId ? 0 : (parseFloat(p.cost) || 0)), 0);
    const packageTotal = packages
      .filter(pkg => usedPackageIds.has(pkg.id))
      .reduce((sum, pkg) => sum + (parseFloat(pkg.cost) || 0), 0);
    const total = individualTotal + packageTotal;
    const packagedStopCount = places.filter(p => p.packageId).length;
    const note = packagedStopCount
      ? `<span class="packaged-count"> (${usedPackageIds.size} package${usedPackageIds.size !== 1 ? 's' : ''}, ${packagedStopCount} stop${packagedStopCount !== 1 ? 's' : ''})</span>`
      : '';
    document.getElementById('budgetTotal').innerHTML = `<span>Est. total</span>$${total.toFixed(2)}${note}`;
  }

  /* ============ Packages (shared prices across multiple stops) ============ */
  async function createPackage() {
    const name = window.prompt('Package name (e.g. "NYC CityPASS" or "Montauk fishing + lunch combo"):');
    if (!name || !name.trim()) return null;
    const costStr = window.prompt(`Total price for "${name.trim()}" ($):`, '0');
    if (costStr === null) return null;
    const pkg = { id: 'pkg-' + Date.now().toString() + Math.random().toString(36).slice(2), name: name.trim(), cost: parseFloat(costStr) || 0 };
    packages.push(pkg);
    await persistPlaces();
    populatePackageSelect();
    renderPlaces();
    showToast('Package created');
    return pkg;
  }

  async function editPackage(id) {
    const pkg = packages.find(pk => pk.id === id);
    if (!pkg) return;
    const name = window.prompt('Package name:', pkg.name);
    if (!name || !name.trim()) return;
    const costStr = window.prompt(`Total price for "${name.trim()}" ($):`, pkg.cost);
    if (costStr === null) return;
    pkg.name = name.trim();
    pkg.cost = parseFloat(costStr) || 0;
    await persistPlaces();
    populatePackageSelect();
    renderPlaces();
    showToast('Package updated');
  }

  async function deletePackage(id) {
    const pkg = packages.find(pk => pk.id === id);
    if (!pkg) return;
    const count = places.filter(p => p.packageId === id).length;
    const warning = count
      ? `Delete "${pkg.name}"? ${count} stop${count !== 1 ? 's' : ''} using it will switch to paying individually (their cost will need re-entering).`
      : `Delete "${pkg.name}"?`;
    if (!window.confirm(warning)) return;
    packages = packages.filter(pk => pk.id !== id);
    places.forEach(p => { if (p.packageId === id) p.packageId = null; });
    await persistPlaces();
    populatePackageSelect();
    renderPlaces();
    showToast('Package deleted');
  }

  function renderPackagesBar() {
    const bar = document.getElementById('packagesBar');
    const list = document.getElementById('packagesList');
    if (!bar || !list) return;
    if (packages.length === 0) { bar.style.display = 'none'; list.innerHTML = ''; return; }
    bar.style.display = 'flex';
    list.innerHTML = packages.map(pkg => {
      const count = places.filter(p => p.packageId === pkg.id).length;
      return `<span class="package-chip">
        <span class="package-chip-name">${escapeHtml(pkg.name)}</span>
        <span class="package-chip-price">$${(parseFloat(pkg.cost) || 0).toFixed(2)}</span>
        <span class="package-chip-count">${count} stop${count !== 1 ? 's' : ''}</span>
        <button type="button" class="package-chip-btn" onclick="editPackage('${pkg.id}')" title="Edit package">✎</button>
        <button type="button" class="package-chip-btn" onclick="deletePackage('${pkg.id}')" title="Delete package">×</button>
      </span>`;
    }).join('');
  }

  function populatePackageSelect(selectedId) {
    const sel = document.getElementById('placePackage');
    if (!sel) return;
    const current = selectedId !== undefined ? selectedId : sel.value;
    sel.innerHTML = '<option value="">No package — pay individually</option>' +
      packages.map(pkg => `<option value="${pkg.id}">${escapeHtml(pkg.name)} — $${(parseFloat(pkg.cost) || 0).toFixed(2)}</option>`).join('') +
      '<option value="__new__">+ New package…</option>';
    sel.value = (current && packages.some(pk => pk.id === current)) ? current : '';
    updatePackageFieldUI();
  }

  async function handlePackageSelectChange() {
    const sel = document.getElementById('placePackage');
    if (sel.value === '__new__') {
      const pkg = await createPackage();
      populatePackageSelect(pkg ? pkg.id : '');
      return;
    }
    updatePackageFieldUI();
  }

  function updatePackageFieldUI() {
    const sel = document.getElementById('placePackage');
    const costInput = document.getElementById('placeCost');
    const hint = document.getElementById('packagePriceHint');
    if (!sel || !costInput || !hint) return;
    if (sel.value && sel.value !== '__new__') {
      const pkg = packages.find(pk => pk.id === sel.value);
      costInput.value = '';
      costInput.disabled = true;
      hint.textContent = pkg ? `Priced as part of "${pkg.name}" — $${(parseFloat(pkg.cost) || 0).toFixed(2)} total, shared across every stop in it.` : '';
      hint.style.display = 'block';
    } else {
      costInput.disabled = false;
      hint.style.display = 'none';
    }
  }

  /* ============ Short description character counter (150 char max) ============ */
  const SUMMARY_MAX_LEN = 150;
  function updateSummaryCharCount() {
    const field = document.getElementById('placeSummary');
    const counter = document.getElementById('summaryCharCount');
    if (!field || !counter) return;
    const len = field.value.length;
    counter.textContent = `${len}/${SUMMARY_MAX_LEN}`;
    counter.classList.toggle('limit', len >= SUMMARY_MAX_LEN);
  }

  /* ============ Image handling (URL, or a picked file downscaled to a data URL) ============ */
  function handleImageUrlInput() {
    const url = document.getElementById('placeImage').value.trim();
    const preview = document.getElementById('imagePreview');
    if (!url) { preview.style.display = 'none'; preview.removeAttribute('src'); return; }
    preview.src = url;
    preview.style.display = 'block';
  }

  /* ============ Collapsible add/edit panel ============ */
  function setAddPanelOpen(open) {
    const wrap = document.getElementById('controlPanelWrap');
    const btn = document.getElementById('addStopToggleBtn');
    const icon = document.getElementById('addStopToggleIcon');
    const label = document.getElementById('addStopToggleLabel');
    if (!wrap || !btn) return;
    wrap.classList.toggle('open', open);
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (label) label.textContent = open ? 'Close' : 'Add a stop';
    if (icon) icon.innerHTML = open
      ? '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
      : '<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
    if (open) {
      setTimeout(() => {
        const nameField = document.getElementById('placeName');
        if (nameField) nameField.focus();
      }, 280);
    }
  }

  function isAddPanelOpen() {
    const wrap = document.getElementById('controlPanelWrap');
    return !!(wrap && wrap.classList.contains('open'));
  }

  function toggleAddPanel() {
    if (isAddPanelOpen()) {
      if (editingId) cancelEdit(); // closing manually also discards an in-progress edit
      else setAddPanelOpen(false);
    } else {
      setAddPanelOpen(true);
    }
  }

  /* ============ Form (add / edit) ============ */
  async function submitForm() {
    const name = document.getElementById('placeName').value.trim();
    const category = document.getElementById('placeCategory').value;
    const day = document.getElementById('placeDay').value.trim();
    const website = document.getElementById('placeWebsite').value.trim();
    const addressRaw = document.getElementById('placeAddress').value.trim();
    const image = document.getElementById('placeImage').value.trim();
    const cost = document.getElementById('placeCost').value;
    const ratingRaw = document.getElementById('placeRating').value;
    const summary = document.getElementById('placeSummary').value.trim().slice(0, SUMMARY_MAX_LEN);
    const desc = document.getElementById('placeDesc').value.trim();
    const packageSel = document.getElementById('placePackage').value;
    const packageId = (packageSel && packageSel !== '__new__') ? packageSel : null;

    if (!name) return alert('Name is required.');

    const rating = ratingRaw === '' ? null : Math.min(5, Math.max(0, parseFloat(ratingRaw)));
    const hasValidRating = rating === null || Number.isFinite(rating);
    if (!hasValidRating) return alert('Rating must be a number between 0 and 5.');

    const dupe = places.find(p => p.name.trim().toLowerCase() === name.toLowerCase() && p.id !== editingId);
    if (dupe && !window.confirm(`"${name}" is already on this itinerary. Add it again anyway?`)) return;

    // Catch a pasted Google Maps link even if the paste event didn't fire
    // (e.g. typed/dragged in), and pull its coordinates + a clean name out
    // of it so we don't save the raw URL as the "address".
    let address = addressRaw;
    let coords = pendingCoords;
    const linkInField = parseGoogleMapsLink(addressRaw);
    if (linkInField && !linkInField.shortened) {
      coords = { lat: linkInField.lat, lng: linkInField.lng };
      if (linkInField.name) address = linkInField.name;
    }

    let placeRef;
    if (editingId) {
      const p = places.find(pl => pl.id === editingId);
      if (p) {
        const addressChanged = p.address !== address;
        p.name = name; p.category = category; p.day = day; p.website = website;
        p.address = address; p.summary = summary; p.desc = desc; p.image = image || null;
        p.cost = packageId ? null : (cost === '' ? null : parseFloat(cost));
        p.rating = rating;
        p.packageId = packageId;
        p.gallery = galleryUrls.slice();
        if (coords) { p.lat = coords.lat; p.lng = coords.lng; }
        else if (addressChanged) { delete p.lat; delete p.lng; } // stale coords for the old address
        placeRef = p;
      }
      showToast('Stop updated');
    } else {
      const newPlace = {
        id: Date.now().toString(), name, category, day, website, address, summary, desc,
        image: image || null, cost: packageId ? null : (cost === '' ? null : parseFloat(cost)), rating, packageId,
        gallery: galleryUrls.slice()
      };
      if (coords) { newPlace.lat = coords.lat; newPlace.lng = coords.lng; }
      places.push(newPlace);
      placeRef = newPlace;
      showToast('Stop added');
    }

    pendingCoords = null;
    resetForm();
    setAddPanelOpen(false);
    renderPlaces();
    await persistPlaces();
  }

  function resetForm() {
    document.getElementById('placeName').value = '';
    document.getElementById('placeCategory').value = 'sightseeing';
    document.getElementById('placeDay').value = '';
    document.getElementById('placeWebsite').value = '';
    document.getElementById('placeAddress').value = '';
    document.getElementById('placeCost').value = '';
    document.getElementById('placeRating').value = '';
    document.getElementById('placeSummary').value = '';
    updateSummaryCharCount();
    document.getElementById('placeDesc').value = '';
    document.getElementById('placeImage').value = '';
    const preview = document.getElementById('imagePreview');
    preview.style.display = 'none';
    preview.removeAttribute('src');
    populatePackageSelect('');
    galleryUrls = [];
    renderGalleryInputs();
    editingId = null;
    document.getElementById('formTitle').textContent = 'Add a stop';
    document.getElementById('editBadge').style.display = 'none';
    document.getElementById('cancelBtn').style.display = 'none';
    document.getElementById('submitBtn').innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg> Add stop';
  }

  function startEdit(id) {
    const p = places.find(pl => pl.id === id);
    if (!p) return;
    editingId = id;
    document.getElementById('placeName').value = p.name;
    document.getElementById('placeCategory').value = p.category;
    document.getElementById('placeDay').value = p.day || '';
    document.getElementById('placeWebsite').value = p.website || '';
    document.getElementById('placeAddress').value = p.address || '';
    document.getElementById('placeCost').value = p.cost != null ? p.cost : '';
    document.getElementById('placeRating').value = p.rating != null ? p.rating : '';
    populatePackageSelect(p.packageId || '');
    document.getElementById('placeSummary').value = p.summary || '';
    updateSummaryCharCount();
    document.getElementById('placeDesc').value = p.desc || '';
    document.getElementById('placeImage').value = p.image || '';
    const preview = document.getElementById('imagePreview');
    if (p.image) { preview.src = p.image; preview.style.display = 'block'; } else { preview.style.display = 'none'; preview.removeAttribute('src'); }
    galleryUrls = Array.isArray(p.gallery) ? p.gallery.slice() : [];
    renderGalleryInputs();

    document.getElementById('formTitle').textContent = 'Edit stop';
    document.getElementById('editBadge').style.display = 'inline-block';
    document.getElementById('cancelBtn').style.display = 'inline-block';
    document.getElementById('submitBtn').textContent = 'Save changes';
    setAddPanelOpen(true);
    setTimeout(() => {
      document.getElementById('controlPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }

  function cancelEdit() { resetForm(); setAddPanelOpen(false); }

  /* ============ Delete (inline confirm + undo) ============ */
  async function requestDelete(id) {
    if (confirmingDeleteId === id) {
      const removed = places.find(p => p.id === id);
      undoSnapshot = JSON.stringify(places);
      places = places.filter(p => p.id !== id);
      confirmingDeleteId = null;
      renderPlaces();
      await persistPlaces();
      announce(`${removed ? removed.name : 'Stop'} removed`);
      showUndoToast('Stop removed');
    } else {
      confirmingDeleteId = id;
      renderPlaces();
      setTimeout(() => { if (confirmingDeleteId === id) { confirmingDeleteId = null; renderPlaces(); } }, 3000);
    }
  }

  /* ============ Reorder ============ */
  async function moveStop(id, direction) {
    const visible = getVisiblePlaces();
    const idx = visible.findIndex(p => p.id === id);
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= visible.length) return;
    const moved = visible[idx];
    const neighborId = visible[newIdx].id;
    const gi = places.findIndex(p => p.id === id);
    const gj = places.findIndex(p => p.id === neighborId);
    undoSnapshot = JSON.stringify(places);
    [places[gi], places[gj]] = [places[gj], places[gi]];
    lastFocusId = id;
    renderPlaces();
    await persistPlaces();
    announce(`${moved.name} moved ${direction < 0 ? 'up' : 'down'}`);
  }

  function handleDragStart(e) {
    draggedId = this.dataset.id;
    dragStartSnapshot = JSON.stringify(places);
    dropHappened = false;
    // Some browsers (Firefox always, Chrome inconsistently — especially over
    // file://) need dataTransfer populated for the drag session to behave;
    // without this the drop can silently fail or visually snap back even
    // though dragover reports a valid target.
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', this.dataset.id); } catch (err) { /* some browsers restrict this on file:// — safe to ignore */ }
    }
    document.body.classList.add('dnd-active');
    setTimeout(() => this.classList.add('dragging'), 0);
  }

  function setDragOver(el) {
    if (dragOverEl && dragOverEl !== el) dragOverEl.classList.remove('drag-over');
    dragOverEl = el;
    if (el) el.classList.add('drag-over');
  }

  // Finds the drop target within a container by locating the *nearest*
  // card/item to the cursor (by center-point distance) and deciding
  // before/after relative to that one card. This is more robust than
  // scanning row-by-row: a sparse last row (fewer cards than columns) or a
  // cursor that's dropped past every card's bounding box still always
  // resolves to *some* real target — in particular, hovering below/right
  // of the last card reliably resolves to "after the last card" instead
  // of occasionally falling through unresolved.
  // Two orientations:
  // - 'grid' (default): nearest card by 2D distance; before/after decided
  //   by which side of that card's horizontal midpoint the cursor is on.
  // - 'list': nearest item by vertical distance only (used for the
  //   single-column Route view); before/after decided by the item's
  //   vertical midpoint.
  // Returns null only when the container has no other items to compare
  // against — callers treat that as "drop at the end of this container".
  function findDropTarget(containerEl, clientX, clientY, opts = {}) {
    const selector = opts.itemSelector || '.card';
    const orientation = opts.orientation || 'grid';
    const items = [...containerEl.querySelectorAll(selector)].filter(el => el.dataset.id !== draggedId);
    if (items.length === 0) return null;

    let nearestEl = null, nearestRect = null, nearestDist = Infinity;
    for (const el of items) {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = orientation === 'list' ? 0 : clientX - cx;
      const dy = clientY - cy;
      const dist = dx * dx + dy * dy;
      if (dist < nearestDist) { nearestDist = dist; nearestEl = el; nearestRect = rect; }
    }

    if (orientation === 'list') {
      const mid = nearestRect.top + nearestRect.height / 2;
      return { targetId: nearestEl.dataset.id, after: clientY >= mid, el: nearestEl };
    }
    const midX = nearestRect.left + nearestRect.width / 2;
    return { targetId: nearestEl.dataset.id, after: clientX >= midX, el: nearestEl };
  }

  // If the dragged place's "day" doesn't match groupKey, updates it so the
  // stop now belongs to whichever day-group container it was dropped into.
  // No-op when groupKey is undefined (grid isn't grouped by day, or this is
  // the Route view, neither of which has a day-group concept for D&D).
  function applyGroupKey(place, groupKey) {
    if (groupKey === undefined || !place) return;
    const current = (place.day && place.day.trim()) ? place.day.trim() : UNSCHEDULED_KEY;
    if (current !== groupKey) place.day = groupKey === UNSCHEDULED_KEY ? '' : groupKey;
  }

  // Keeps the `places` array in sync with the on-screen order as the user
  // drags, snapping the dragged item next to a specific target card/item.
  // Returns false (and leaves the array untouched) if the dragged item or
  // target can't be found.
  function reorderPlacesArray(targetId, after, groupKey) {
    const gi = places.findIndex(p => p.id === draggedId);
    if (gi === -1) return false;
    const item = places.splice(gi, 1)[0];
    let newIdx = places.findIndex(p => p.id === targetId);
    if (newIdx === -1) { places.splice(gi, 0, item); return false; }
    if (after) newIdx += 1;
    places.splice(newIdx, 0, item);
    applyGroupKey(item, groupKey);
    return true;
  }

  // Used when a container has no other cards to snap next to (an empty day
  // group, or the only-other-card-is-the-dragged-one case) — places the
  // dragged item after the last existing member of that group, or at the
  // very end of the array if the group is otherwise empty.
  function insertAtGroupEnd(groupKey) {
    const gi = places.findIndex(p => p.id === draggedId);
    if (gi === -1) return false;
    const item = places.splice(gi, 1)[0];
    let lastIdx = -1;
    for (let i = 0; i < places.length; i++) {
      const pk = (places[i].day && places[i].day.trim()) ? places[i].day.trim() : UNSCHEDULED_KEY;
      if (pk === groupKey) lastIdx = i;
    }
    places.splice(lastIdx === -1 ? places.length : lastIdx + 1, 0, item);
    applyGroupKey(item, groupKey);
    return true;
  }

  // Moves a card's real DOM element to sit at the end of `container`,
  // just before its end-drop-zone if present. Used when dragging into an
  // empty container (or the only other occupant is the dragged card).
  function moveDraggedElToContainerEnd(container, draggedEl) {
    const endZone = container.querySelector('.end-drop-zone');
    if (endZone) container.insertBefore(draggedEl, endZone); else container.appendChild(draggedEl);
  }

  function handleContainerDragOver(e) {
    if (!draggedId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

    // Search the whole board, not just `this` — the dragged card may
    // currently live inside a *different* day-group container than the
    // one the cursor is over now, which is exactly the cross-group-move
    // case we need to support.
    const draggedEl = viewContainer.querySelector(`.card[data-id="${draggedId}"]`);
    if (!draggedEl) return;

    const groupKey = this.dataset.groupKey; // undefined when grid isn't grouped by day
    const result = findDropTarget(this, e.clientX, e.clientY, { itemSelector: '.card', orientation: 'grid' });

    if (result) {
      setDragOver(result.el);
      if (result.el === draggedEl) return;
      const alreadyInPlace = result.after
        ? draggedEl.previousElementSibling === result.el
        : draggedEl.nextElementSibling === result.el;
      if (!alreadyInPlace) {
        // Move the real card element — NOT a re-render — so the browser's
        // native drag session (anchored to this DOM node) stays alive,
        // while the other cards visually push out of the way. `.after()`/
        // `.before()` transparently relocate it even across containers.
        if (result.after) result.el.after(draggedEl); else result.el.before(draggedEl);
      }
      reorderPlacesArray(result.targetId, result.after, groupKey);
    } else {
      // Nothing to snap next to in this container (it's empty, or the
      // dragged card is the only thing in it) — drop it at this
      // container's end instead, so every bit of empty space is a valid
      // target, not just the area right next to an existing card.
      const endZone = this.querySelector('.end-drop-zone');
      setDragOver(endZone || this);
      const alreadyAtEnd = draggedEl.parentElement === this &&
        (!endZone || draggedEl.nextElementSibling === endZone);
      if (!alreadyAtEnd) moveDraggedElToContainerEnd(this, draggedEl);
      if (groupKey !== undefined) insertAtGroupEnd(groupKey);
    }
  }

  async function handleContainerDrop(e) {
    e.preventDefault();
    if (!draggedId) { console.warn('[waypoint] drop fired with no draggedId set'); return; }
    try {
      setDragOver(null);
      dropHappened = true;

      const moved = places.find(p => p.id === draggedId);
      if (!moved) { console.warn('[waypoint] dragged place not found in places[]', draggedId); return; }

      // The array was already reordered live during dragover; just persist.
      undoSnapshot = dragStartSnapshot;
      renderPlaces();
      await persistPlaces();
      announce(`${moved.name} reordered`);
      showUndoToast('Order updated');
    } catch (err) {
      console.error('[waypoint] reorder failed:', err);
    }
  }

  // ---- Route view drag & drop (flat list, no day-group concept) ----
  function handleRouteDragStart(e) {
    draggedId = this.dataset.id;
    dragStartSnapshot = JSON.stringify(places);
    dropHappened = false;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', this.dataset.id); } catch (err) { /* ignore */ }
    }
    document.body.classList.add('dnd-active');
    setTimeout(() => this.classList.add('dragging'), 0);
  }

  function handleRouteContainerDragOver(e) {
    if (!draggedId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

    const draggedEl = this.querySelector(`.route-item[data-id="${draggedId}"]`);
    if (!draggedEl) return;

    const result = findDropTarget(this, e.clientX, e.clientY, { itemSelector: '.route-item', orientation: 'list' });
    if (!result) { setDragOver(null); return; }

    setDragOver(result.el);
    if (result.el === draggedEl) return;
    const alreadyInPlace = result.after
      ? draggedEl.previousElementSibling === result.el
      : draggedEl.nextElementSibling === result.el;
    if (!alreadyInPlace) {
      if (result.after) result.el.after(draggedEl); else result.el.before(draggedEl);
    }
    reorderPlacesArray(result.targetId, result.after);
  }

  async function handleRouteContainerDrop(e) {
    e.preventDefault();
    if (!draggedId) { console.warn('[waypoint] drop fired with no draggedId set'); return; }
    try {
      setDragOver(null);
      dropHappened = true;

      const moved = places.find(p => p.id === draggedId);
      if (!moved) { console.warn('[waypoint] dragged place not found in places[]', draggedId); return; }

      undoSnapshot = dragStartSnapshot;
      renderPlaces();
      await persistPlaces();
      announce(`${moved.name} reordered`);
      showUndoToast('Order updated');
    } catch (err) {
      console.error('[waypoint] route reorder failed:', err);
    }
  }

  function buildEndDropZone() {
    // Purely a visual affordance now — the container-level dragover/drop
    // listeners (which this element bubbles up into) already handle drops
    // anywhere below the last card, this just shows the user where.
    const zone = document.createElement('div');
    zone.className = 'end-drop-zone';
    zone.setAttribute('aria-hidden', 'true');
    zone.textContent = 'Drop here to move to the end';
    return zone;
  }

  function handleDragEnd() {
    this.classList.remove('dragging');
    if (!dropHappened && dragStartSnapshot) {
      // Drag was cancelled (e.g. dropped outside the list, or Esc) —
      // restore the pre-drag order rather than keeping the live shuffle.
      places = JSON.parse(dragStartSnapshot);
      renderPlaces();
    }
    draggedId = null;
    dragStartSnapshot = null;
    dropHappened = false;
    setDragOver(null);
    document.body.classList.remove('dnd-active');
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  }

  function handleCardKeydown(e, id) {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      moveStop(id, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button, a')) {
      e.preventDefault();
      const p = places.find(pl => pl.id === id);
      if (p && p.desc) openDetailModal(id);
    }
  }

  // Ignore clicks on anything interactive (buttons, links, drag handle,
  // star rating) — those already handle themselves — and open the detail
  // modal for everything else, so the whole card is the "view details"
  // trigger instead of one small button competing for space.
  function handleCardClick(e, id, hasDesc) {
    if (!hasDesc) return;
    if (e.target.closest('button, a')) return;
    openDetailModal(id);
  }

  /* ============ Export list to clipboard ============ */
  function copyItinerary() {
    const visible = getVisiblePlaces();
    if (visible.length === 0) { showToast('Nothing to copy'); return; }
    const lines = visible.map((p, i) => {
      const parts = [`${i + 1}. ${p.name}`];
      if (p.day) parts.push(`[${p.day}]`);
      parts.push(`(${categoryLabel(p.category)})`);
      const formattedRating = (p.rating != null && p.rating !== '') ? formatRating(p.rating) : null;
      if (formattedRating !== null) parts.push(`★ ${formattedRating}`);
      if (p.packageId) {
        const pkg = packages.find(pk => pk.id === p.packageId);
        parts.push(`- part of "${pkg ? pkg.name : 'package'}"${pkg ? ` ($${(parseFloat(pkg.cost) || 0).toFixed(2)} total)` : ''}`);
      } else if (p.cost != null && p.cost !== '') parts.push(p.cost == 0 ? '- Free' : `- $${parseFloat(p.cost).toFixed(2)}`);
      let line = parts.join(' ');
      if (p.summary) line += `\n   ${p.summary}`;
      if (p.address) line += `\n   ${p.address}`;
      if (p.desc) line += `\n   ${p.desc}`;
      if (p.website) line += `\n   ${p.website}`;
      return line;
    });
    const text = `${currentTrip() ? currentTrip().name : 'Itinerary'}\n\n${lines.join('\n\n')}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => showToast('Itinerary copied')).catch(() => showToast('Could not copy'));
    } else {
      showToast('Clipboard not available');
    }
  }

  /* ============ Rendering ============ */
  const CATEGORY_LABELS = {
    sightseeing: 'Attractions',
    dining: 'Food & Drink',
    outdoors: 'Outdoors & Nature',
    skyscrapers: 'City & Architecture',
    'museums-culture': 'Culture & Museums',
    'entertainment-nightlife': 'Entertainment & Nightlife',
    shopping: 'Shopping',
    'viewpoints-photography': 'Views & Photography'
  };
  function categoryLabel(category) { return CATEGORY_LABELS[category] || category; }

  function categoryDotColor(category) {
    return {
      dining: 'var(--tag-dining)',
      sightseeing: 'var(--tag-sightseeing)',
      outdoors: 'var(--tag-outdoors)',
      skyscrapers: 'var(--tag-skyscrapers)',
      'museums-culture': 'var(--tag-museums)',
      'entertainment-nightlife': 'var(--tag-entertainment)',
      shopping: 'var(--tag-shopping)',
      'viewpoints-photography': 'var(--tag-viewpoints)'
    }[category];
  }

  // Rating lives directly on the card/route item as clickable stars — no
  // need to open Edit just to rate a stop. Clicking a star sets a whole
  // number; clicking the currently-set star again clears it. There's no way
  // to pull a live aggregate from Google/Yelp here — this artifact runs in
  // a sandboxed iframe that blocks fetch() to third-party APIs (same reason
  // coordinates come from pasted Maps links instead of geocoding) — so this
  // is the trip owner's own rating, with an optional exact-score field in
  // the form for typing a precise decimal (e.g. copying a real 4.7).
  function formatRating(rating) {
    const n = parseFloat(rating);
    return Number.isFinite(n) ? n.toFixed(1) : null;
  }

  const CARD_STAR_SVG = '<svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1.6l2.53 5.13 5.66.82-4.1 4 .97 5.65L10 14.9l-5.06 2.3.97-5.65-4.1-4 5.66-.82L10 1.6z"/></svg>';

  async function rateStop(id, value) {
    const p = places.find(pl => pl.id === id);
    if (!p) return;
    // Clicking the already-committed star again clears the rating.
    p.rating = (p.rating != null && Math.round(p.rating) === value) ? null : value;
    renderPlaces();
    if (detailModalTriggerId === id) {
      const starRow = document.querySelector('#detailModalBody .detail-modal-star-row');
      if (starRow) starRow.innerHTML = buildStarRowHtml(p);
    }
    await persistPlaces();
    announce(p.rating != null ? `${p.name} rated ${p.rating} star${p.rating === 1 ? '' : 's'}` : `${p.name} rating cleared`);
  }

  function buildStarRowHtml(place) {
    const rounded = place.rating != null ? Math.round(place.rating) : 0;
    let buttons = '';
    for (let v = 5; v >= 1; v--) {
      buttons += `<button type="button" class="card-star-btn ${v <= rounded ? 'filled' : ''}" onclick="event.stopPropagation(); rateStop('${place.id}', ${v})" title="Rate ${v} star${v > 1 ? 's' : ''}" aria-label="Rate ${v} star${v > 1 ? 's' : ''}">${CARD_STAR_SVG}</button>`;
    }
    const formatted = place.rating != null ? formatRating(place.rating) : null;
    const valueLabel = formatted !== null
      ? `<span class="card-star-value">${formatted}</span>`
      : `<span class="card-star-value muted">Rate it</span>`;
    return `<div class="card-star-row" role="radiogroup" aria-label="Your rating for ${escapeHtml(place.name)}"><div class="card-star-buttons">${buttons}</div>${valueLabel}</div>`;
  }

  // Trims a full address down to a short "badge" location (e.g. "Liberty
  // Island, New York" from "Liberty Island, New York, NY 10004") — the
  // full address still appears in full in the info bar below.
  function shortLocation(address) {
    if (!address) return null;
    const parts = address.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length <= 2) return parts.join(', ');
    return parts.slice(0, 2).join(', ');
  }

  /* ============ Detail modal (full-screen image + all tips/notes) ============ */
  let detailModalTriggerId = null; // which stop's button opened the modal, so focus can return to it

  // Three-column strip (provider/category, price, location) shown at the
  // top of the detail modal — a quick-glance summary before the tips.
  function buildInfoBarHtml(p) {
    const placePkg = p.packageId ? packages.find(pk => pk.id === p.packageId) : null;
    const websiteUrl = normalizeWebsiteUrl(p.website);

    const col1Icon = placePkg ? TIP_ICONS.ticket : TIP_ICONS.bulb;
    const col1Label = placePkg ? placePkg.name : categoryLabel(p.category);
    const col1Sub = websiteUrl ? 'Official website' : 'Category';
    const col1TextInner = `<div class="detail-info-label" title="${escapeHtml(col1Label)}">${escapeHtml(col1Label)}</div><div class="detail-info-sub">${escapeHtml(col1Sub)}</div>`;
    const col1Text = websiteUrl
      ? `<a class="detail-info-text detail-info-link" href="${websiteUrl}" target="_blank" rel="noopener" title="Official website">${col1TextInner}</a>`
      : `<div class="detail-info-text">${col1TextInner}</div>`;

    const priceVal = placePkg ? (parseFloat(placePkg.cost) || 0) : (p.cost != null && p.cost !== '' ? parseFloat(p.cost) : null);
    const col2Label = priceVal == null ? '—' : (priceVal === 0 ? 'Free' : `$${priceVal.toFixed(2)}`);
    const col2Sub = placePkg ? 'Total price' : 'Price';

    const col3Label = p.address ? p.address : 'No address added';
    const col3Sub = 'Location';
    const col3MapsUrl = p.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.address)}` : null;
    const col3TextInner = `<div class="detail-info-label" title="${escapeHtml(col3Label)}">${escapeHtml(col3Label)}</div><div class="detail-info-sub">${escapeHtml(col3Sub)}</div>`;
    const col3Text = col3MapsUrl
      ? `<a class="detail-info-text detail-info-link" href="${col3MapsUrl}" target="_blank" rel="noopener" title="Open in Google Maps">${col3TextInner}</a>`
      : `<div class="detail-info-text">${col3TextInner}</div>`;

    return `<div class="detail-info-bar">
      <div class="detail-info-item"><span class="detail-info-icon">${col1Icon}</span>${col1Text}</div>
      <div class="detail-info-divider"></div>
      <div class="detail-info-item"><span class="detail-info-icon">${TIP_ICONS.coin}</span><div class="detail-info-text"><div class="detail-info-label">${escapeHtml(col2Label)}</div><div class="detail-info-sub">${escapeHtml(col2Sub)}</div></div></div>
      <div class="detail-info-divider"></div>
      <div class="detail-info-item"><span class="detail-info-icon">${TIP_ICONS.pin}</span>${col3Text}</div>
    </div>`;
  }

  function openDetailModal(id) {
    const p = places.find(pl => pl.id === id);
    if (!p) return;
    const overlay = document.getElementById('detailModalOverlay');
    const body = document.getElementById('detailModalBody');
    if (!overlay || !body) return;

    const mapsUrl = p.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.address)}` : null;
    const citymapperUrl = buildCitymapperUrl(p);
    const websiteUrl = normalizeWebsiteUrl(p.website);
    const galleryPhotos = [p.image, ...((Array.isArray(p.gallery) ? p.gallery : []))].filter(Boolean);
    const imageMarkup = p.image
      ? `<img class="detail-modal-image" src="${p.image}" alt="${escapeHtml(p.name)}" style="cursor:zoom-in;" onclick="openLightbox('${p.id}', 0)">`
      : `<div class="detail-modal-image-placeholder hero-placeholder">
           <svg width="34" height="34" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="8.5" cy="10" r="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M21 15l-5-4-4 3-3-2-6 5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
         </div>`;
    const galleryStripHtml = galleryPhotos.length > 1
      ? `<div class="detail-gallery-strip">${galleryPhotos.map((url, i) => `
          <button type="button" class="detail-gallery-thumb${i === 0 ? ' active' : ''}" onclick="openLightbox('${p.id}', ${i})" title="View photo ${i + 1}">
            <img src="${escapeHtml(url)}" alt="Photo ${i + 1} of ${escapeHtml(p.name)}" onerror="this.parentElement.style.display='none'">
          </button>`).join('')}</div>`
      : '';

    body.innerHTML = `
      <div class="detail-modal-hero">
        ${imageMarkup}
        <div class="detail-modal-hero-scrim" aria-hidden="true"></div>
        <div class="detail-modal-hero-content">
          <span class="detail-modal-hero-badge">${TIP_ICONS.pin}${escapeHtml(shortLocation(p.address) || categoryLabel(p.category))}</span>
          <h2 class="detail-modal-hero-title" id="detailModalTitle">${escapeHtml(p.name)}</h2>
          ${p.day ? `<div class="detail-modal-hero-day">${escapeHtml(p.day)}</div>` : ''}
          <div class="detail-modal-star-row star-row-on-image">${buildStarRowHtml(p)}</div>
        </div>
      </div>
      ${galleryStripHtml}
      <div class="detail-modal-content">
        ${buildInfoBarHtml(p)}
        ${(citymapperUrl && isMobileDevice()) ? `<div class="detail-modal-links">
          <a class="card-citymapper" href="${citymapperUrl}" target="_blank" rel="noopener" title="Get directions in Citymapper">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M3 11l17-8-8 17-2.5-6.5L3 11z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>
            Citymapper
          </a>
        </div>` : ''}
        ${p.summary ? `<p class="detail-modal-summary">${escapeHtml(p.summary)}</p>` : ''}
        <h3 class="detail-modal-desc-heading"><span class="detail-modal-desc-heading-icon">${TIP_ICONS.bulb}</span>Tips &amp; Tricks</h3>
        <div class="detail-modal-desc">${p.desc ? renderDescHtml(p.desc) : 'No tips added yet.'}</div>
      </div>
    `;

    detailModalTriggerId = id;
    overlay.classList.add('open');
    document.body.classList.add('modal-open');
    document.addEventListener('keydown', handleDetailModalKeydown);
    const closeBtn = document.getElementById('detailModalCloseBtn');
    if (closeBtn) closeBtn.focus();
  }

  function closeDetailModal() {
    const overlay = document.getElementById('detailModalOverlay');
    if (!overlay || !overlay.classList.contains('open')) return;
    overlay.classList.remove('open');
    document.body.classList.remove('modal-open');
    document.removeEventListener('keydown', handleDetailModalKeydown);
    if (detailModalTriggerId) {
      const el = document.querySelector(`.card[data-id="${detailModalTriggerId}"], .route-item[data-id="${detailModalTriggerId}"]`);
      if (el) el.focus();
    }
    detailModalTriggerId = null;
  }

  function handleDetailModalKeydown(e) {
    if (e.key === 'Escape') closeDetailModal();
  }

  /* ============ Lightbox (full-screen gallery viewer) ============ */
  let lightboxPhotos = [];
  let lightboxIndex = 0;

  function openLightbox(placeId, startIndex) {
    const p = places.find(pl => pl.id === placeId);
    if (!p) return;
    lightboxPhotos = [p.image, ...((Array.isArray(p.gallery) ? p.gallery : []))].filter(Boolean);
    if (lightboxPhotos.length === 0) return;
    lightboxIndex = Math.min(Math.max(startIndex || 0, 0), lightboxPhotos.length - 1);
    renderLightbox();
    document.getElementById('lightboxOverlay').classList.add('open');
    document.addEventListener('keydown', handleLightboxKeydown);
  }

  function renderLightbox() {
    const img = document.getElementById('lightboxImage');
    const counter = document.getElementById('lightboxCounter');
    if (!img || !counter) return;
    img.src = lightboxPhotos[lightboxIndex];
    img.alt = `Photo ${lightboxIndex + 1} of ${lightboxPhotos.length}`;
    counter.textContent = lightboxPhotos.length > 1 ? `${lightboxIndex + 1} / ${lightboxPhotos.length}` : '';
    document.querySelectorAll('.detail-gallery-thumb').forEach((el, i) => el.classList.toggle('active', i === lightboxIndex));
    const multi = lightboxPhotos.length > 1;
    document.querySelector('.lightbox-prev').style.display = multi ? 'flex' : 'none';
    document.querySelector('.lightbox-next').style.display = multi ? 'flex' : 'none';
  }

  function lightboxStep(delta) {
    if (lightboxPhotos.length === 0) return;
    lightboxIndex = (lightboxIndex + delta + lightboxPhotos.length) % lightboxPhotos.length;
    renderLightbox();
  }

  function closeLightbox() {
    const overlay = document.getElementById('lightboxOverlay');
    if (!overlay) return;
    overlay.classList.remove('open');
    document.removeEventListener('keydown', handleLightboxKeydown);
  }

  function handleLightboxKeydown(e) {
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') lightboxStep(-1);
    else if (e.key === 'ArrowRight') lightboxStep(1);
  }

  function buildCardEl(place, globalIndex, visible) {
    const card = document.createElement('div');
    card.className = 'card' + (place.desc ? ' has-desc' : '');
    card.dataset.id = place.id;
    card.draggable = true;
    card.tabIndex = 0;
    card.setAttribute('aria-label', `${place.name}, stop ${globalIndex + 1}.${place.desc ? ' Press Enter for full details.' : ''} Press Alt plus arrow keys to reorder.`);

    card.addEventListener('click', (e) => handleCardClick(e, place.id, !!place.desc));
    card.addEventListener('dragstart', handleDragStart);
    card.addEventListener('dragend', handleDragEnd);
    card.addEventListener('keydown', (e) => handleCardKeydown(e, place.id));

    const idxInVisible = visible.findIndex(p => p.id === place.id);
    const isFirst = idxInVisible === 0;
    const isLast = idxInVisible === visible.length - 1;
    const isConfirming = confirmingDeleteId === place.id;

    const placePkg = place.packageId ? packages.find(pk => pk.id === place.packageId) : null;
    const cardCostValue = placePkg ? (parseFloat(placePkg.cost) || 0) : (place.cost != null && place.cost !== '' ? parseFloat(place.cost) : null);
    const cardPriceBadgeHtml = cardCostValue != null
      ? `<span class="price-badge${cardCostValue === 0 ? ' free' : ''}">${cardCostValue === 0 ? 'Free' : '$' + cardCostValue.toFixed(2)}</span>`
      : '';

    const categoryBadge = `<span class="category-tag card-badge tag-${place.category}">${categoryLabel(place.category)}</span>`;
    const imageMarkup = (place.image
      ? `<img class="card-image" src="${place.image}" alt="${escapeHtml(place.name)}" draggable="false">`
      : `<div class="card-image-placeholder" draggable="false">
           <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="8.5" cy="10" r="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M21 15l-5-4-4 3-3-2-6 5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
         </div>`) + categoryBadge + cardPriceBadgeHtml;

    const mapsUrl = place.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.address)}` : null;
    const citymapperUrl = buildCitymapperUrl(place);
    const websiteUrl = normalizeWebsiteUrl(place.website);
    // Always render this wrapper — even when there's no package — so it
    // reserves the exact same strip of physical space on every card. The
    // wrapper's own fixed height (not a min-height floor — see the lesson
    // from the description/title fixes above) is what guarantees an empty
    // placeholder can't collapse smaller than a real "Statue City Cruises"
    // pill, which is what was pushing the address/website rows upward on
    // cards with no provider data.
    const costLineHtml = `<div class="card-meta-line packaged-line provider-tag-placeholder">${placePkg ? `<span class="included-pill">${escapeHtml(placePkg.name)}</span>` : ''}</div>`;

    card.innerHTML = `
      ${imageMarkup}
      <div class="card-body">
        <div class="card-header">
          <h3 class="card-title" title="${escapeHtml(place.name)}">${escapeHtml(place.name)}</h3>
        </div>
        <div class="card-desc-wrap">
          <div class="card-desc">${getCardBlurb(place) ? escapeHtml(getCardBlurb(place)) : 'No description added.'}</div>
          ${place.desc ? `<div class="card-readmore-inline">View insider tips</div>` : ''}
        </div>
        ${costLineHtml}
        ${mapsUrl ? `<div class="directions-links">
          <a class="card-address" href="${mapsUrl}" target="_blank" rel="noopener" title="Open in Google Maps">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 21s7-7.5 7-12a7 7 0 1 0-14 0c0 4.5 7 12 7 12z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="9" r="2.2" stroke="currentColor" stroke-width="1.8"/></svg>
            ${escapeHtml(place.address)}
          </a>
          ${(citymapperUrl && isMobileDevice()) ? `<a class="card-citymapper" href="${citymapperUrl}" target="_blank" rel="noopener" title="Get directions in Citymapper">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M3 11l17-8-8 17-2.5-6.5L3 11z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>
            Citymapper
          </a>` : ''}
        </div>` : ''}
        ${websiteUrl ? `<a class="card-website" href="${websiteUrl}" target="_blank" rel="noopener" title="Official website (opening times, tickets, etc.)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9.2" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.8c2.4 2.6 3.7 5.9 3.7 9.2s-1.3 6.6-3.7 9.2M12 2.8c-2.4 2.6-3.7 5.9-3.7 9.2s1.3 6.6 3.7 9.2M2.8 12h18.4" stroke="currentColor" stroke-width="1.4"/></svg>
          Official website
        </a>` : ''}
        <div class="card-footer">
          ${buildStarRowHtml(place)}
          <div class="footer-actions">
            <button class="icon-only-btn edit-btn" onclick="event.stopPropagation(); startEdit('${place.id}')" title="Edit stop" aria-label="Edit ${escapeHtml(place.name)}">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M11 2l3 3-8.5 8.5L2 14l0.5-3.5L11 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>
            </button>
            <button class="icon-only-btn delete-btn ${isConfirming ? 'confirming' : ''}" onclick="event.stopPropagation(); requestDelete('${place.id}')" title="${isConfirming ? 'Click again to confirm removal' : 'Remove stop'}" aria-label="${isConfirming ? 'Confirm removal of ' + escapeHtml(place.name) : 'Remove ' + escapeHtml(place.name)}">
              ${isConfirming
                ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.5 3.5L13 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
                : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l0.6 8.4a1 1 0 0 0 1 0.9h3.8a1 1 0 0 0 1-0.9l0.6-8.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'}
            </button>
          </div>
        </div>
      </div>
    `;

    return card;
  }

  function renderEmptyState(container, reason) {
    const messages = {
      filter: ['No stops in this category', 'Try a different filter, or add a new stop above.'],
      search: ['No matches', 'Try a different search term.'],
      none: ['No stops yet', 'Add your first place above to start building the route.']
    };
    const [lead, sub] = messages[reason];
    container.innerHTML = `
      <div class="empty-state">
        <div class="glyph">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2L4 7v10l8 5 8-5V7l-8-5z" stroke="#0d9488" stroke-width="1.6" stroke-linejoin="round"/></svg>
        </div>
        <p class="lead">${lead}</p>
        <p>${sub}</p>
      </div>`;
  }

  function renderGridView(container, visible) {
    const groupByDay = document.getElementById('groupByDayToggle').checked;

    if (!groupByDay) {
      const grid = document.createElement('div');
      grid.className = 'grid-container';
      visible.forEach(place => {
        const gi = places.findIndex(p => p.id === place.id);
        grid.appendChild(buildCardEl(place, gi, visible));
      });
      grid.appendChild(buildEndDropZone());
      grid.addEventListener('dragover', handleContainerDragOver);
      grid.addEventListener('drop', handleContainerDrop);
      container.appendChild(grid);
      return;
    }

    const groups = []; const groupMap = {};
    visible.forEach(place => {
      const key = place.day && place.day.trim() ? place.day.trim() : UNSCHEDULED_KEY;
      if (!groupMap[key]) { groupMap[key] = []; groups.push(key); }
      groupMap[key].push(place);
    });

    groups.forEach((key) => {
      const wrap = document.createElement('div');
      wrap.className = 'day-group';
      const title = document.createElement('h3');
      title.className = 'day-group-title';
      title.innerHTML = `${escapeHtml(key)} <span class="count">${groupMap[key].length} stop${groupMap[key].length > 1 ? 's' : ''}</span>`;
      wrap.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'grid-container';
      grid.dataset.groupKey = key; // lets drag handlers know which day a drop here should assign
      groupMap[key].forEach(place => {
        const gi = places.findIndex(p => p.id === place.id);
        grid.appendChild(buildCardEl(place, gi, visible));
      });
      // Every group gets its own end-drop-zone (not just the last one) so
      // you can drop into any group's empty space, or into a group that's
      // momentarily empty because its only card is the one being dragged.
      grid.appendChild(buildEndDropZone());
      grid.addEventListener('dragover', handleContainerDragOver);
      grid.addEventListener('drop', handleContainerDrop);
      wrap.appendChild(grid);
      container.appendChild(wrap);
    });
  }

  function renderRouteView(container, visible) {
    const list = document.createElement('div');
    list.className = 'route-list';

    visible.forEach((place, i) => {
      const gi = places.findIndex(p => p.id === place.id);
      const placePkg = place.packageId ? packages.find(pk => pk.id === place.packageId) : null;
      const routeCostValue = placePkg ? (parseFloat(placePkg.cost) || 0) : (place.cost != null && place.cost !== '' ? parseFloat(place.cost) : null);
      const routePriceHtml = routeCostValue != null
        ? `<span class="route-price${routeCostValue === 0 ? ' free' : ''}">${routeCostValue === 0 ? 'Free' : '$' + routeCostValue.toFixed(2)}</span>`
        : '';
      // Price now sits next to the title — this line just credits the
      // shared package by name, since the price alone doesn't say what it covers.
      const costLineHtml = placePkg
        ? `<div class="route-cost packaged-line"><span class="included-pill">${escapeHtml(placePkg.name)}</span></div>`
        : '';
      const routeWebsiteUrl = normalizeWebsiteUrl(place.website);
      const routeMapsUrl = place.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.address)}` : null;
      const routeCitymapperUrl = buildCitymapperUrl(place);
      const item = document.createElement('div');
      item.className = 'route-item' + (place.desc ? ' has-desc' : '');
      item.dataset.id = place.id;
      item.draggable = true;
      item.tabIndex = 0;
      item.setAttribute('aria-label', `${place.name}, stop ${gi + 1}.${place.desc ? ' Press Enter for full details.' : ''} Press Alt plus arrow keys to reorder.`);
      item.addEventListener('click', (e) => handleCardClick(e, place.id, !!place.desc));
      item.addEventListener('dragstart', handleRouteDragStart);
      item.addEventListener('dragend', handleDragEnd);
      item.addEventListener('keydown', (e) => handleCardKeydown(e, place.id));
      item.innerHTML = `
        <div class="route-line-wrap">
          <div class="route-dot" style="background:${categoryDotColor(place.category)}"></div>
          ${i < visible.length - 1 ? `<div class="route-connector"></div>` : ''}
        </div>
        <div class="route-content">
          <div class="route-meta">
            <span class="stop-index">${gi + 1}</span>
            <span class="category-tag tag-${place.category}">${categoryLabel(place.category)}</span>
            ${place.day ? `<span class="stop-time">${escapeHtml(place.day)}</span>` : ''}
          </div>
          <div class="route-title-row">
            <h4 class="route-title" title="${escapeHtml(place.name)}">${escapeHtml(place.name)}</h4>
            ${routePriceHtml}
          </div>
          <div class="card-desc-wrap">
            <div class="route-desc">${getCardBlurb(place) ? escapeHtml(getCardBlurb(place)) : (place.address ? escapeHtml(place.address) : 'No description added.')}</div>
            ${place.desc ? `<div class="card-readmore-inline">View insider tips</div>` : ''}
          </div>
          ${routeMapsUrl ? `<div class="directions-links">
            <a class="card-address" href="${routeMapsUrl}" target="_blank" rel="noopener" title="Open in Google Maps">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 21s7-7.5 7-12a7 7 0 1 0-14 0c0 4.5 7 12 7 12z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="9" r="2.2" stroke="currentColor" stroke-width="1.8"/></svg>
              Google Maps
            </a>
            ${(routeCitymapperUrl && isMobileDevice()) ? `<a class="card-citymapper" href="${routeCitymapperUrl}" target="_blank" rel="noopener" title="Get directions in Citymapper">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M3 11l17-8-8 17-2.5-6.5L3 11z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>
              Citymapper
            </a>` : ''}
          </div>` : ''}
          ${routeWebsiteUrl ? `<a class="card-website" href="${routeWebsiteUrl}" target="_blank" rel="noopener" title="Official website (opening times, tickets, etc.)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9.2" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.8c2.4 2.6 3.7 5.9 3.7 9.2s-1.3 6.6-3.7 9.2M12 2.8c-2.4 2.6-3.7 5.9-3.7 9.2s1.3 6.6 3.7 9.2M2.8 12h18.4" stroke="currentColor" stroke-width="1.4"/></svg>
            Official website
          </a>` : ''}
          ${costLineHtml}
          ${buildStarRowHtml(place)}
        </div>
      `;
      list.appendChild(item);
    });

    list.appendChild(buildEndDropZone());
    list.addEventListener('dragover', handleRouteContainerDragOver);
    list.addEventListener('drop', handleRouteContainerDrop);
    container.appendChild(list);
  }

  function renderPlaces() {
    viewContainer.innerHTML = '';
    updateBudgetTotal();
    renderPackagesBar();

    if (isLoading) {
      const grid = document.createElement('div');
      grid.className = 'grid-container';
      for (let i = 0; i < 3; i++) {
        const skeleton = document.createElement('div');
        skeleton.className = 'card';
        skeleton.style.height = '230px';
        skeleton.style.background = 'linear-gradient(90deg, #f1f3f6 25%, #f8f9fb 37%, #f1f3f6 63%)';
        skeleton.style.backgroundSize = '400% 100%';
        skeleton.style.animation = 'shimmer 1.4s ease infinite';
        grid.appendChild(skeleton);
      }
      viewContainer.appendChild(grid);
      return;
    }

    const visible = getVisiblePlaces();

    if (visible.length === 0) {
      const q = document.getElementById('searchInput').value.trim();
      renderEmptyState(viewContainer, places.length === 0 ? 'none' : (q ? 'search' : 'filter'));
      return;
    }

    if (currentView === 'route') renderRouteView(viewContainer, visible);
    else renderGridView(viewContainer, visible);

    if (lastFocusId) {
      const el = viewContainer.querySelector(`[data-id="${lastFocusId}"]`);
      if (el) el.focus();
      lastFocusId = null;
    }
  }

  /* ============ Toolbar events ============ */
  document.getElementById('filterGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('.pill-btn');
    if (!btn) return;
    currentFilter = btn.dataset.filter;
    document.querySelectorAll('#filterGroup .pill-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderPlaces();
  });

  document.getElementById('viewToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.pill-btn');
    if (!btn) return;
    currentView = btn.dataset.view;
    document.querySelectorAll('#viewToggle .pill-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderPlaces();
  });

  const styleSheet = document.createElement('style');
  styleSheet.textContent = '@keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }';
  document.head.appendChild(styleSheet);

  /* ============ Init ============ */
  (async function init() {
    await loadTripsIndex();
    currentTripId = trips[0].id;
    renderTripSelect();
    await loadCurrentTripPlaces();
  })();
