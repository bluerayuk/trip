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
    "time": "",
    "address": "Liberty Island, New York, NY 10004",
    "desc": "• Book a \"Reserve\" ticket to skip lines and arrive 45-60 minutes early for mandatory security.\n\n• Stand on the starboard (right) side of the ferry for the best views and photo angles on the approach.\n\n• Budget 4-5 hours for the full tour; bring quarters for lockers as large daypacks aren't allowed inside.",
    "image": "images/1.jpg",
    "cost": null,
    "travelNext": "15 min ferry ride to Ellis Island",
    "packageId": "pkg-1788129485954n4a8xunrpce",
    "hoursByDay": null,
    "seasons": [
      {
        "id": "season-1788201588441-0",
        "label": "Summer",
        "startMonth": 6,
        "endMonth": 8,
        "hoursByDay": {
          "mon": {
            "from": "08:30",
            "to": "18:30"
          },
          "tue": {
            "from": "08:30",
            "to": "18:30"
          },
          "wed": {
            "from": "08:30",
            "to": "18:30"
          },
          "thu": {
            "from": "08:30",
            "to": "18:30"
          },
          "fri": {
            "from": "08:30",
            "to": "18:30"
          },
          "sat": {
            "from": "08:30",
            "to": "18:30"
          },
          "sun": {
            "from": "08:30",
            "to": "18:30"
          }
        }
      },
      {
        "id": "season-1788201588441-1",
        "label": "Winter",
        "startMonth": 9,
        "endMonth": 5,
        "hoursByDay": {
          "mon": {
            "from": "09:00",
            "to": "17:00"
          },
          "tue": {
            "from": "09:00",
            "to": "17:00"
          },
          "wed": {
            "from": "09:00",
            "to": "17:00"
          },
          "thu": {
            "from": "09:00",
            "to": "17:00"
          },
          "fri": {
            "from": "09:00",
            "to": "17:00"
          },
          "sat": {
            "from": "09:00",
            "to": "17:00"
          },
          "sun": {
            "from": "09:00",
            "to": "17:00"
          }
        }
      }
    ],
    "lat": 40.6892,
    "lng": -74.0445
  },
  {
    "id": "s3",
    "name": "New York Crown",
    "category": "sightseeing",
    "day": "",
    "time": "",
    "address": "Liberty Island, New York, NY 10004",
    "desc": "• Book \"Crown Reserve\" tickets months in advance; you must bring a matching photo ID to Castle Clinton to get mandatory wristbands.\n\n• Wear closed-toe shoes for the strenuous, tight climb up 162 narrow spiral steps (there is no elevator beyond the pedestal).\n\n• Strict security allows only cameras, phones, water, and meds. Bring quarters for mandatory lockers to store all bags.",
    "image": "images/2.jpg",
    "cost": 0.3,
    "travelNext": "15 min ferry ride to Ellis Island",
    "packageId": null,
    "hoursByDay": null,
    "seasons": [
      {
        "id": "season-1788205035838-0",
        "label": "Summer",
        "startMonth": 6,
        "endMonth": 8,
        "hoursByDay": {
          "mon": {
            "from": "08:30",
            "to": "18:30"
          },
          "tue": {
            "from": "08:30",
            "to": "18:30"
          },
          "wed": {
            "from": "08:30",
            "to": "18:30"
          },
          "thu": {
            "from": "08:30",
            "to": "18:30"
          },
          "fri": {
            "from": "08:30",
            "to": "18:30"
          },
          "sat": {
            "from": "08:30",
            "to": "18:30"
          },
          "sun": {
            "from": "08:30",
            "to": "18:30"
          }
        }
      },
      {
        "id": "season-1788205035839-1",
        "label": "Winter",
        "startMonth": 9,
        "endMonth": 5,
        "hoursByDay": {
          "mon": {
            "from": "09:00",
            "to": "17:00"
          },
          "tue": {
            "from": "09:00",
            "to": "17:00"
          },
          "wed": {
            "from": "09:00",
            "to": "17:00"
          },
          "thu": {
            "from": "09:00",
            "to": "17:00"
          },
          "fri": {
            "from": "09:00",
            "to": "17:00"
          },
          "sat": {
            "from": "09:00",
            "to": "17:00"
          },
          "sun": {
            "from": "09:00",
            "to": "17:00"
          }
        }
      }
    ],
    "lat": 40.6892,
    "lng": -74.0445
  },
  {
    "id": "1788127853367",
    "name": "Ellis Island National Museum of Immigration",
    "category": "museums-culture",
    "day": "",
    "time": "",
    "address": "Ellis Island, New York, NY 10004",
    "desc": "• Pick up the self-guided audio tour headset right at the entrance, as it is fully included with your standard ferry ticket.\n\n• Budget 2-3 hours to explore the main exhibits and Great Hall, or book an additional 90-minute \"Hard Hat Tour\" of the unrestored hospital grounds.\n\n• The museum begins closing 30 minutes before the final ferry departs; track the seasonal boat schedule closely to avoid missing your return trip.",
    "image": "images/3.jpg",
    "cost": null,
    "travelNext": "15-20 min ferry ride back to Battery Park (Manhattan)",
    "packageId": "pkg-1788129485954n4a8xunrpce",
    "hoursByDay": null,
    "seasons": [
      {
        "id": "season-1788205886652-2",
        "label": "Summer",
        "startMonth": 6,
        "endMonth": 8,
        "hoursByDay": {
          "mon": {
            "from": "08:30",
            "to": "18:30"
          },
          "tue": {
            "from": "08:30",
            "to": "18:30"
          },
          "wed": {
            "from": "08:30",
            "to": "18:30"
          },
          "thu": {
            "from": "08:30",
            "to": "18:30"
          },
          "fri": {
            "from": "08:30",
            "to": "18:30"
          },
          "sat": {
            "from": "08:30",
            "to": "18:30"
          },
          "sun": {
            "from": "08:30",
            "to": "18:30"
          }
        }
      },
      {
        "id": "season-1788205886652-3",
        "label": "Winter",
        "startMonth": 9,
        "endMonth": 5,
        "hoursByDay": {
          "mon": {
            "from": "09:00",
            "to": "17:00"
          },
          "tue": {
            "from": "09:00",
            "to": "17:00"
          },
          "wed": {
            "from": "09:00",
            "to": "17:00"
          },
          "thu": {
            "from": "09:00",
            "to": "17:00"
          },
          "fri": {
            "from": "09:00",
            "to": "17:00"
          },
          "sat": {
            "from": "09:00",
            "to": "17:00"
          },
          "sun": {
            "from": "09:00",
            "to": "17:00"
          }
        }
      }
    ],
    "lat": 40.6995,
    "lng": -74.0396
  },
  {
    "id": "s1",
    "name": "Empire State Building Observatory",
    "category": "skyscrapers",
    "day": "",
    "time": "09:00-00:00",
    "address": "20 W 34th St., New York, NY 10001",
    "desc": "• Budget 1.5 to 2 hours for the visit, and book tickets well in advance if you want the highly popular sunset time slot.\n\n• Standard admission provides access to the open-air 86th floor, while the smaller 102nd-floor enclosed deck requires a pricier ticket upgrade.\n\n• All visitors must pass mandatory security screenings; large bags, glass items, and camera tripods are strictly prohibited.",
    "image": "images/4.jpg",
    "cost": 44,
    "travelNext": "",
    "packageId": null,
    "hoursByDay": null,
    "seasons": null,
    "lat": 40.7484,
    "lng": -73.9857
  },
  {
    "id": "1788179669671",
    "name": "Times Square",
    "category": "outdoors",
    "day": "",
    "time": "24h",
    "address": "Manhattan, NY 10036",
    "desc": "• Visit late in the evening when the giant digital billboards are brightest and the peak daytime crowds have slightly thinned out.\n\n• Avoid interacting with costumed characters or accepting \"free\" CDs from street vendors unless you are prepared to hand over a cash tip.\n\n• Head to the red glass steps at the TKTS booth in Duffy Square if you want to check for same-day discounted Broadway show tickets.",
    "image": "images/5.jpg",
    "cost": 0,
    "travelNext": "",
    "packageId": null,
    "hoursByDay": null,
    "seasons": null,
    "lat": 40.758,
    "lng": -73.9855
  },
  {
    "id": "1788195131854",
    "name": "Brooklyn Bridge",
    "category": "outdoors",
    "day": "",
    "time": "24h",
    "address": "New York, NY 10038",
    "desc": "• Start the walk on the Brooklyn side heading toward Manhattan so the iconic city skyline is always directly in front of you.\n\n• Budget 45 to 60 minutes for the crossing; there is absolutely no shade on the bridge, so bring water and sun protection on clear days.\n\n• Cross early in the morning or late in the evening to avoid the massive midday tourist crowds and bottlenecks on the pedestrian walkway.",
    "image": "images/brooklyn-bridge.jpg",
    "cost": 0,
    "travelNext": "",
    "packageId": null,
    "hoursByDay": null,
    "seasons": null,
    "lat": 40.7061,
    "lng": -73.9969
  },
  {
    "id": "1788196267169",
    "name": "Grand Central Terminal",
    "category": "sightseeing",
    "day": "",
    "time": "05:15-02:00",
    "address": "89 E 42nd St, New York, NY 10017",
    "desc": "• View the famous celestial ceiling in the Main Concourse, but stand near the edges to avoid blocking the fast-moving paths of local commuters.\n\n• Test the acoustics at the Whispering Gallery located just outside the lower-level Oyster Bar by having two people whisper into opposite diagonal corners.\n\n• Utilize the lower-level Dining Concourse as a highly convenient pit stop for clean public restrooms and a wide variety of quick food options.",
    "image": "images/grand-central-terminal.jpg",
    "cost": 0,
    "travelNext": "",
    "packageId": null,
    "hoursByDay": null,
    "seasons": null,
    "lat": 40.7527,
    "lng": -73.9772
  },
  {
    "id": "1788197283793",
    "name": "Central Park",
    "category": "outdoors",
    "day": "",
    "time": "06:00-01:00",
    "address": "72 Terrace Dr, New York, NY 10021",
    "desc": "• The park is massive (843 acres); do not attempt to walk the whole thing in one day, but rather focus on a specific section like the southern loop for iconic spots like Bethesda Terrace and Bow Bridge.\n\n• If you get turned around, check the cast-iron lampposts lining the paths; the first two or three digits on the metal plaque indicate the closest cross street.\n\n• Stick to the designated pedestrian paths and look both ways before crossing the main loop roads, as they are heavily trafficked by fast-moving cyclists and pedicabs.",
    "image": "images/central-park.jpg",
    "cost": 0,
    "travelNext": "",
    "packageId": null,
    "hoursByDay": null,
    "seasons": null,
    "lat": 40.7794,
    "lng": -73.9632
  },
  {
    "id": "1788197581955",
    "name": "The High Line",
    "category": "outdoors",
    "day": "",
    "time": "07:00-22:00",
    "address": "820 Washington St, New York, NY 10014",
    "desc": "• Start at the southern entrance (Gansevoort Street) and walk north; this route allows you to easily grab lunch at Chelsea Market and end your walk right at Hudson Yards.\n\n• Walk the path on a weekday morning to avoid severe pedestrian bottlenecks, as the narrow, elevated walkway gets heavily congested on weekends.\n\n• Not all street-level access points have elevators; if you want to avoid stairs, check the official map in advance so you don't get stuck walking further than intended.",
    "image": "images/the-high-line.jpg",
    "cost": 0,
    "travelNext": "",
    "packageId": null,
    "hoursByDay": null,
    "seasons": null,
    "lat": 40.74,
    "lng": -74.006
  },
  {
    "id": "1788197817249",
    "name": "Little Island",
    "category": "outdoors",
    "day": "",
    "time": "06:00-00:00",
    "address": "Pier 55 at Hudson River Park, New York, NY 10014",
    "desc": "• Combine this stop with The High Line, as the southern entrance on Gansevoort Street is just a short 5-minute walk away from the pier.\n\n• General admission is completely free, and timed-entry reservations are no longer required to enter the park at any time.\n\n• Follow the paved pathways up to the main amphitheater (The Amph) to access the highest elevation points for clear, unobstructed views of the downtown skyline.",
    "image": "images/little-island.jpg",
    "cost": 0,
    "travelNext": "",
    "packageId": null,
    "hoursByDay": null,
    "seasons": null,
    "lat": 40.7423,
    "lng": -74.0125
  },
  {
    "id": "1788199698262",
    "name": "The Metropolitan Museum of Art (The Met)",
    "category": "museums-culture",
    "day": "",
    "time": "",
    "address": "1000 5th Ave, New York, NY 10028",
    "desc": "• Do not attempt to see the massive collection in a single visit; pick two or three specific wings to focus on to avoid museum fatigue.\n\n• Schedule your visit around the museum's strict Wednesday closures; if you want to avoid daytime crowds, aim for Friday or Saturday when doors stay open until 9:00 PM.\n\n• Bypass the crowded main steps by using the ground-level entrance located at 81st Street, which typically has much shorter security and ticketing lines.",
    "image": "images/11.jpg",
    "cost": 30,
    "travelNext": "",
    "packageId": null,
    "hoursByDay": {
      "mon": {
        "from": "10:00",
        "to": "17:00"
      },
      "tue": {
        "from": "10:00",
        "to": "17:00"
      },
      "wed": {
        "closed": true
      },
      "thu": {
        "from": "10:00",
        "to": "17:00"
      },
      "fri": {
        "from": "10:00",
        "to": "21:00"
      },
      "sat": {
        "from": "10:00",
        "to": "21:00"
      },
      "sun": {
        "from": "10:00",
        "to": "17:00"
      }
    },
    "seasons": null,
    "lat": 40.7794,
    "lng": -73.9632
  },
  {
    "id": "1788207781358",
    "name": "The Museum of Modern Art (MoMA)",
    "category": "museums-culture",
    "day": "",
    "time": "",
    "address": "11 W 53rd St, New York, NY 10019",
    "desc": "• Take the elevator straight to the 5th floor when you arrive to view the most famous pieces, like \"The Starry Night,\" before working your way down through the less crowded galleries.\n\n• Avoid visiting on Friday evenings from 5:30 PM to 8:30 PM if you want to dodge heavy crowds, as this time block offers free admission to New York residents.\n\n• Travel light, as all bags larger than 11×17×5 inches, including rolling luggage and skateboards, are strictly prohibited and cannot be checked at the coatroom.",
    "image": "images/12.jpg",
    "cost": 30,
    "travelNext": "",
    "packageId": null,
    "hoursByDay": {
      "mon": {
        "from": "10:30",
        "to": "20:30"
      },
      "tue": {
        "from": "10:30",
        "to": "20:30"
      },
      "wed": {
        "from": "10:30",
        "to": "20:30"
      },
      "thu": {
        "from": "10:30",
        "to": "20:30"
      },
      "fri": {
        "from": "10:30",
        "to": "20:30"
      },
      "sat": {
        "from": "10:30",
        "to": "17:30"
      },
      "sun": {
        "from": "10:30",
        "to": "17:30"
      }
    },
    "seasons": null,
    "lat": 40.7614,
    "lng": -73.9776
  },
  {
    "id": "1788208427264",
    "name": "9/11 Memorial & Museum",
    "category": "museums-culture",
    "day": "",
    "time": "",
    "address": "180 Greenwich St, New York, NY 10007",
    "desc": "• The outdoor memorial pools are free and accessible to the public daily, but the underground museum requires a paid, timed-entry ticket and is closed on Tuesdays.\n\n• Budget 2 to 3 hours for the museum; you must pass through mandatory airport-style security, so aim to arrive 15 minutes before your ticketed time slot.\n\n• Download the official audio guide app to your phone before heading down to the main exhibits, as cellular network service is virtually nonexistent underground.",
    "image": "images/13.jpg",
    "cost": 33,
    "travelNext": "",
    "packageId": null,
    "hoursByDay": {
      "mon": {
        "from": "09:00",
        "to": "19:00"
      },
      "tue": {
        "closed": true
      },
      "wed": {
        "from": "09:00",
        "to": "19:00"
      },
      "thu": {
        "from": "09:00",
        "to": "19:00"
      },
      "fri": {
        "from": "09:00",
        "to": "19:00"
      },
      "sat": {
        "from": "09:00",
        "to": "19:00"
      },
      "sun": {
        "from": "09:00",
        "to": "19:00"
      }
    },
    "seasons": null,
    "lat": 40.7115,
    "lng": -74.0134
  },
  {
    "id": "1788209020575",
    "name": "Edge NYC Observatory",
    "category": "skyscrapers",
    "day": "",
    "time": "",
    "address": "30 Hudson Yards, New York, NY 10001",
    "desc": "• Access the entrance on Level 4 inside The Shops at Hudson Yards, which allows you to easily pair this visit with the northern trailhead of The High Line just outside.\n\n• Book tickets several weeks in advance if you want a highly sought-after sunset time slot, and expect to pay an upcharge for those specific peak hours.\n\n• The outdoor viewing area features a completely see-through glass floor and angled glass walls; avoid wearing skirts or dresses if you plan to walk on the glass due to the reflective surfaces below.",
    "image": "images/14.jpg",
    "cost": 39,
    "travelNext": "",
    "packageId": null,
    "hoursByDay": null,
    "seasons": [
      {
        "id": "season-1788208981720-2",
        "label": "Summer",
        "startMonth": 6,
        "endMonth": 8,
        "hoursByDay": {
          "mon": {
            "from": "08:00",
            "to": "00:00"
          },
          "tue": {
            "from": "08:00",
            "to": "00:00"
          },
          "wed": {
            "from": "08:00",
            "to": "00:00"
          },
          "thu": {
            "from": "08:00",
            "to": "00:00"
          },
          "fri": {
            "from": "08:00",
            "to": "00:00"
          },
          "sat": {
            "from": "08:00",
            "to": "00:00"
          },
          "sun": {
            "from": "08:00",
            "to": "00:00"
          }
        }
      },
      {
        "id": "season-1788208981722-3",
        "label": "Winter",
        "startMonth": 9,
        "endMonth": 5,
        "hoursByDay": {
          "mon": {
            "from": "10:00",
            "to": "22:00"
          },
          "tue": {
            "from": "10:00",
            "to": "22:00"
          },
          "wed": {
            "from": "10:00",
            "to": "22:00"
          },
          "thu": {
            "from": "10:00",
            "to": "22:00"
          },
          "fri": {
            "from": "10:00",
            "to": "22:00"
          },
          "sat": {
            "from": "10:00",
            "to": "22:00"
          },
          "sun": {
            "from": "10:00",
            "to": "22:00"
          }
        }
      }
    ],
    "lat": 40.7538,
    "lng": -74.0022
  },
  {
    "id": "1788209444903",
    "name": "One World Observatory",
    "category": "skyscrapers",
    "day": "",
    "time": "",
    "address": "117 West St, New York, NY 10007",
    "desc": "• Locate the main visitor entrance on West Street, as it is completely separate from the 9/11 Memorial pools and the Oculus transit hub.\n\n• This is the only major NYC observation deck that is entirely enclosed indoors, making it the most reliable choice for rainy, windy, or extremely cold days.\n\n• To reduce heavy glare and reflections from the thick double-paned windows, press your phone or camera lens directly flat against the glass when taking pictures.",
    "image": "images/15.jpg",
    "cost": 44,
    "travelNext": "",
    "packageId": null,
    "hoursByDay": null,
    "seasons": [
      {
        "id": "season-1788209420134-4",
        "label": "Summer",
        "startMonth": 6,
        "endMonth": 8,
        "hoursByDay": {
          "mon": {
            "from": "09:00",
            "to": "22:00"
          },
          "tue": {
            "from": "09:00",
            "to": "22:00"
          },
          "wed": {
            "from": "09:00",
            "to": "22:00"
          },
          "thu": {
            "from": "09:00",
            "to": "22:00"
          },
          "fri": {
            "from": "09:00",
            "to": "22:00"
          },
          "sat": {
            "from": "09:00",
            "to": "22:00"
          },
          "sun": {
            "from": "09:00",
            "to": "22:00"
          }
        }
      },
      {
        "id": "season-1788209420135-5",
        "label": "Winter",
        "startMonth": 9,
        "endMonth": 5,
        "hoursByDay": {
          "mon": {
            "from": "09:00",
            "to": "21:00"
          },
          "tue": {
            "from": "09:00",
            "to": "21:00"
          },
          "wed": {
            "from": "09:00",
            "to": "21:00"
          },
          "thu": {
            "from": "09:00",
            "to": "21:00"
          },
          "fri": {
            "from": "09:00",
            "to": "21:00"
          },
          "sat": {
            "from": "09:00",
            "to": "21:00"
          },
          "sun": {
            "from": "09:00",
            "to": "21:00"
          }
        }
      }
    ],
    "lat": 40.7127,
    "lng": -74.0134
  },
  {
    "id": "1788209854164",
    "name": "Top of the Rock Observatory",
    "category": "skyscrapers",
    "day": "",
    "time": "08:00-00:00",
    "address": "30 Rockefeller Plaza, New York, NY 10112",
    "desc": "• Locate the main visitor entrance on 50th Street between 5th and 6th Avenues to save time, rather than wandering through the main Rockefeller Center concourse.\n\n• Head all the way up to the uppermost tier on the 70th floor to enjoy completely unobstructed, open-air views without any glass panels or wire fencing.\n\n• This observatory is widely considered the best option for classic skyline views because it offers a perfectly centered, dead-on look at the Empire State Building to the south and Central Park to the north.",
    "image": "images/16.jpg",
    "cost": 43,
    "travelNext": "",
    "packageId": null,
    "hoursByDay": null,
    "seasons": null,
    "lat": 40.7587,
    "lng": -73.9787
  },
  {
    "id": "1788210119109",
    "name": "American Museum of Natural History",
    "category": "museums-culture",
    "day": "",
    "time": "10:00-17:30",
    "address": "200 Central Park West, New York, NY 10024",
    "desc": "• General admission requires booking a timed-entry ticket online in advance; special exhibits like the Hayden Planetarium or the Butterfly Vivarium require pricier upgraded tickets.\n\n• Avoid the heavy bottlenecks at the main Central Park West entrance by using the lower-level subway entrance on 81st Street or the new Gilder Center doors on Columbus Avenue.\n\n• Download the free AMNH Explorer app before you arrive to access an interactive, blue-dot navigation map, as the massive, multi-building layout is notoriously easy to get lost in.",
    "image": "images/17.jpg",
    "cost": 28,
    "travelNext": "",
    "packageId": null,
    "hoursByDay": null,
    "seasons": null,
    "lat": 40.7813,
    "lng": -73.974
  },
  {
    "id": "1788210434835",
    "name": "Intrepid Museum",
    "category": "museums-culture",
    "day": "",
    "time": "",
    "address": "Pier 86, W 46th St, New York, NY 10036",
    "desc": "• The museum is located on the Hudson River; wear layers and prepare for the elements, as the outdoor flight deck is highly exposed to strong winds and direct sun.\n\n• Touring the Growler submarine requires navigating extremely tight spaces and passing through a small hatch model beforehand; all large bags must be left in the provided bins before entering.\n\n• The nearest subway stations are a very long walk (roughly 15 to 20 minutes) from the pier, so consider taking a crosstown bus (like the M42 or M50) directly to 12th Avenue to save your feet.",
    "image": "images/18.jpg",
    "cost": 36,
    "travelNext": "",
    "packageId": null,
    "hoursByDay": null,
    "seasons": [
      {
        "id": "season-1788210316286-6",
        "label": "Summer",
        "startMonth": 4,
        "endMonth": 9,
        "hoursByDay": {
          "mon": {
            "from": "10:00",
            "to": "17:00"
          },
          "tue": {
            "from": "10:00",
            "to": "17:00"
          },
          "wed": {
            "from": "10:00",
            "to": "17:00"
          },
          "thu": {
            "from": "10:00",
            "to": "17:00"
          },
          "fri": {
            "from": "10:00",
            "to": "17:00"
          },
          "sat": {
            "from": "10:00",
            "to": "18:00"
          },
          "sun": {
            "from": "10:00",
            "to": "18:00"
          }
        }
      },
      {
        "id": "season-1788210316287-7",
        "label": "Winter",
        "startMonth": 9,
        "endMonth": 5,
        "hoursByDay": {
          "mon": {
            "from": "10:00",
            "to": "17:00"
          },
          "tue": {
            "from": "10:00",
            "to": "17:00"
          },
          "wed": {
            "from": "10:00",
            "to": "17:00"
          },
          "thu": {
            "from": "10:00",
            "to": "17:00"
          },
          "fri": {
            "from": "10:00",
            "to": "17:00"
          },
          "sat": {
            "from": "10:00",
            "to": "17:00"
          },
          "sun": {
            "from": "10:00",
            "to": "17:00"
          }
        }
      }
    ],
    "lat": 40.7642,
    "lng": -73.9997
  },
  {
    "id": "1788210762631",
    "name": "Vessel",
    "category": "outdoors",
    "day": "",
    "time": "",
    "address": "20 Hudson Yards, New York, NY 10001",
    "desc": "• General admission requires a paid, timed-entry ticket booked in advance, though New York City residents can visit for free on Thursdays by presenting a valid local ID.\n\n• Budget 30 to 45 minutes to climb the honeycomb-like structure; steel safety netting is now installed on the upper platforms, but the gaps are wide enough to take clear, unobstructed photos.\n\n• An elevator is available for those who need it, and the 154 interconnected flights of stairs are broken into short, manageable sections allowing you to rest on any landing or turn back at any time.",
    "image": "images/19.jpg",
    "cost": 14,
    "travelNext": "",
    "packageId": null,
    "hoursByDay": {
      "mon": {
        "from": "11:00",
        "to": "19:00"
      },
      "tue": {
        "from": "11:00",
        "to": "19:00"
      },
      "wed": {
        "from": "11:00",
        "to": "19:00"
      },
      "thu": {
        "from": "11:00",
        "to": "19:00"
      },
      "fri": {
        "from": "09:00",
        "to": "19:00"
      },
      "sat": {
        "from": "09:00",
        "to": "19:00"
      },
      "sun": {
        "from": "09:00",
        "to": "20:00"
      }
    },
    "seasons": null,
    "lat": 40.7536,
    "lng": -74.0025
  },
  {
    "id": "1788211021015",
    "name": "St. Patrick's Cathedral",
    "category": "sightseeing",
    "day": "",
    "time": "06:30-20:00",
    "address": "5th Ave, New York, NY 10022",
    "desc": "• The cathedral is completely free to enter, but as an active place of worship, check the daily schedule online to avoid arriving during a Mass or private event.\n\n• Security guards perform brief bag checks at the main 5th Avenue entrances; travel light to keep the line moving, as large luggage and backpacks are not permitted.\n\n• Budget 15 to 20 minutes for a self-guided walk-through to see the massive organ and stained glass, and skip the paid audio tour unless you want deep architectural details.",
    "image": "images/20.jpg",
    "cost": 0,
    "travelNext": "",
    "packageId": null,
    "hoursByDay": null,
    "seasons": null,
    "lat": 40.7583,
    "lng": -73.9761
  },
  {
    "id": "1788295416885",
    "name": "Madame Tussauds New York",
    "category": "sightseeing",
    "day": "",
    "time": "",
    "address": "234 W 42nd St, New York, NY 10036",
    "desc": "• Purchase your tickets online in advance to bypass the notoriously long walk-up lines that form along the crowded 42nd Street sidewalk.\n\n• Budget 1.5 to 2 hours for the self-guided walkthrough; there are no ropes or glass barriers, so you can step right up to the figures for interactive photos.\n\n• Travel light and avoid bringing large bags, as they are subject to mandatory security searches at the entrance and the museum does not offer coat or luggage checks.",
    "image": "images/21.jpg",
    "cost": 44,
    "travelNext": "",
    "packageId": null,
    "hoursByDay": {
      "mon": {
        "from": "10:00",
        "to": "19:00"
      },
      "tue": {
        "from": "10:00",
        "to": "19:00"
      },
      "wed": {
        "from": "10:00",
        "to": "19:00"
      },
      "thu": {
        "from": "10:00",
        "to": "19:00"
      },
      "fri": {
        "from": "10:00",
        "to": "21:00"
      },
      "sat": {
        "from": "10:00",
        "to": "21:00"
      },
      "sun": {
        "from": "10:00",
        "to": "19:00"
      }
    },
    "seasons": null,
    "lat": 40.7563,
    "lng": -73.988
  },
  {
    "id": "1788295918065",
    "name": "Mercer Labs – Museum of Art and Technology",
    "category": "museums-culture",
    "day": "",
    "time": "",
    "address": "21 Dey St, New York, NY 10007",
    "desc": "• Budget 1.5 to 2 hours. Be prepared for immersive, multi-sensory rooms with intense lighting and audio.\n\n• Located one block east of the Oculus; pairs perfectly with the World Trade Center.\n\n• Travel light. Oversized bags are strictly prohibited and there is no luggage check available.",
    "image": "images/22.jpg",
    "cost": 52,
    "travelNext": "",
    "packageId": null,
    "hoursByDay": {
      "mon": {
        "from": "10:00",
        "to": "20:00"
      },
      "tue": {
        "from": "10:00",
        "to": "20:00"
      },
      "wed": {
        "from": "10:00",
        "to": "20:00"
      },
      "thu": {
        "from": "10:00",
        "to": "20:00"
      },
      "fri": {
        "from": "10:00",
        "to": "22:00"
      },
      "sat": {
        "from": "10:00",
        "to": "22:00"
      },
      "sun": {
        "from": "10:00",
        "to": "20:00"
      }
    },
    "seasons": null,
    "lat": 40.7104,
    "lng": -74.01
  },
  {
    "id": "1788297048914",
    "name": "Circle Line NYC Landmarks Cruise",
    "category": "sightseeing",
    "day": "",
    "time": "",
    "address": "Pier 83, W 42nd St, New York, NY 10036",
    "desc": "See times on website\n\n\n• Arrive 45 minutes before departure to pass through security and secure a prime outdoor seat.\n\n• Sit on the left (port) side of the boat for the absolute best, unobstructed views of the Statue of Liberty.\n\n• Bring a light jacket or windbreaker even on warm days, as the breeze on the open water is surprisingly cold.",
    "image": "images/23.jpg",
    "cost": 41,
    "travelNext": "",
    "packageId": null,
    "hoursByDay": null,
    "seasons": null,
    "lat": 40.7626,
    "lng": -73.9977
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

  /* ============ Description rendering (bullet lists, line breaks) ============ */
  // Plain text in a <p> collapses all newlines, so a pasted bullet list like
  // "- Book ahead\n- Bring cash" renders as one run-on line. This detects
  // that shape and builds a real <ul>/<ol>; otherwise it just preserves the
  // line breaks the user typed. Always escapes first — never trust raw text.
  function renderDescHtml(desc) {
    if (!desc) return '';
    const lines = desc.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '');
    if (lines.length === 0) return '';
    const bulletRe = /^[-*•]\s+/;
    const numRe = /^\d+[.)]\s+/;
    const isList = lines.length > 1 && lines.every(l => bulletRe.test(l) || numRe.test(l));
    if (isList) {
      const ordered = numRe.test(lines[0]);
      const tag = ordered ? 'ol' : 'ul';
      const items = lines.map(l => `<li>${escapeHtml(l.replace(bulletRe, '').replace(numRe, ''))}</li>`).join('');
      return `<${tag} class="desc-list">${items}</${tag}>`;
    }
    return lines.map(l => escapeHtml(l)).join('<br>');
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

  /* ============ Image handling (URL, or a picked file downscaled to a data URL) ============ */
  function handleImageUrlInput() {
    const url = document.getElementById('placeImage').value.trim();
    const preview = document.getElementById('imagePreview');
    if (!url) { preview.style.display = 'none'; preview.removeAttribute('src'); return; }
    preview.src = url;
    preview.style.display = 'block';
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
    const desc = document.getElementById('placeDesc').value.trim();
    const packageSel = document.getElementById('placePackage').value;
    const packageId = (packageSel && packageSel !== '__new__') ? packageSel : null;

    if (!name) return alert('Name is required.');

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
        p.address = address; p.desc = desc; p.image = image || null;
        p.cost = packageId ? null : (cost === '' ? null : parseFloat(cost));
        p.packageId = packageId;
        if (coords) { p.lat = coords.lat; p.lng = coords.lng; }
        else if (addressChanged) { delete p.lat; delete p.lng; } // stale coords for the old address
        placeRef = p;
      }
      showToast('Stop updated');
    } else {
      const newPlace = {
        id: Date.now().toString(), name, category, day, website, address, desc,
        image: image || null, cost: packageId ? null : (cost === '' ? null : parseFloat(cost)), packageId
      };
      if (coords) { newPlace.lat = coords.lat; newPlace.lng = coords.lng; }
      places.push(newPlace);
      placeRef = newPlace;
      showToast('Stop added');
    }

    pendingCoords = null;
    resetForm();
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
    document.getElementById('placeDesc').value = '';
    document.getElementById('placeImage').value = '';
    const preview = document.getElementById('imagePreview');
    preview.style.display = 'none';
    preview.removeAttribute('src');
    populatePackageSelect('');
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
    populatePackageSelect(p.packageId || '');
    document.getElementById('placeDesc').value = p.desc || '';
    document.getElementById('placeImage').value = p.image || '';
    const preview = document.getElementById('imagePreview');
    if (p.image) { preview.src = p.image; preview.style.display = 'block'; } else { preview.style.display = 'none'; preview.removeAttribute('src'); }

    document.getElementById('formTitle').textContent = 'Edit stop';
    document.getElementById('editBadge').style.display = 'inline-block';
    document.getElementById('cancelBtn').style.display = 'inline-block';
    document.getElementById('submitBtn').textContent = 'Save changes';
    document.getElementById('controlPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function cancelEdit() { resetForm(); }

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
    if (!this._dragFromHandle) { e.preventDefault(); return; }
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
    }
  }

  /* ============ Export list to clipboard ============ */
  function copyItinerary() {
    const visible = getVisiblePlaces();
    if (visible.length === 0) { showToast('Nothing to copy'); return; }
    const lines = visible.map((p, i) => {
      const parts = [`${i + 1}. ${p.name}`];
      if (p.day) parts.push(`[${p.day}]`);
      parts.push(`(${categoryLabel(p.category)})`);
      if (p.packageId) {
        const pkg = packages.find(pk => pk.id === p.packageId);
        parts.push(`- part of "${pkg ? pkg.name : 'package'}"${pkg ? ` ($${(parseFloat(pkg.cost) || 0).toFixed(2)} total)` : ''}`);
      } else if (p.cost != null && p.cost !== '') parts.push(p.cost == 0 ? '- Free' : `- $${parseFloat(p.cost).toFixed(2)}`);
      let line = parts.join(' ');
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
    sightseeing: 'Sightseeing',
    dining: 'Dining',
    outdoors: 'Outdoors',
    skyscrapers: 'Skyscrapers',
    'museums-culture': 'Museums & Culture',
    'entertainment-nightlife': 'Entertainment & Nightlife',
    shopping: 'Shopping',
    'viewpoints-photography': 'Viewpoints & Photography'
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

  function buildCardEl(place, globalIndex, visible) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = place.id;
    card.draggable = true;
    card.tabIndex = 0;
    card.setAttribute('aria-label', `${place.name}, stop ${globalIndex + 1}. Press Alt plus arrow keys to reorder.`);

    card._dragFromHandle = false;
    card.addEventListener('mousedown', (e) => { card._dragFromHandle = !!e.target.closest('.drag-handle'); });
    card.addEventListener('touchstart', (e) => { card._dragFromHandle = !!e.target.closest('.drag-handle'); }, { passive: true });

    card.addEventListener('dragstart', handleDragStart);
    card.addEventListener('dragend', handleDragEnd);
    card.addEventListener('keydown', (e) => handleCardKeydown(e, place.id));

    const idxInVisible = visible.findIndex(p => p.id === place.id);
    const isFirst = idxInVisible === 0;
    const isLast = idxInVisible === visible.length - 1;
    const isConfirming = confirmingDeleteId === place.id;

    const categoryBadge = `<span class="category-tag card-badge tag-${place.category}">${categoryLabel(place.category)}</span>`;
    const imageMarkup = (place.image
      ? `<img class="card-image" src="${place.image}" alt="${escapeHtml(place.name)}" draggable="false">`
      : `<div class="card-image-placeholder" draggable="false">
           <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="8.5" cy="10" r="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M21 15l-5-4-4 3-3-2-6 5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
         </div>`) + categoryBadge;

    const mapsUrl = place.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.address)}` : null;
    const citymapperUrl = buildCitymapperUrl(place);
    const websiteUrl = normalizeWebsiteUrl(place.website);
    const placePkg = place.packageId ? packages.find(pk => pk.id === place.packageId) : null;
    const costLineHtml = placePkg
      ? `<div class="card-meta-line packaged-line"><span class="included-pill">${escapeHtml(placePkg.name)}</span><span class="package-price">$${(parseFloat(placePkg.cost) || 0).toFixed(2)} <span class="price-note">total</span></span></div>`
      : (place.cost != null && place.cost !== '' ? `<div class="card-meta-line cost">${parseFloat(place.cost) === 0 ? 'Free' : '$' + parseFloat(place.cost).toFixed(2)}</div>` : '');

    card.innerHTML = `
      ${imageMarkup}
      <div class="card-body">
        <div class="card-header">
          <div class="card-header-top">
            <div class="card-header-left">
              <div class="drag-handle" title="Drag to reorder" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="5" cy="3" r="1.2" fill="currentColor"/><circle cx="11" cy="3" r="1.2" fill="currentColor"/><circle cx="5" cy="8" r="1.2" fill="currentColor"/><circle cx="11" cy="8" r="1.2" fill="currentColor"/><circle cx="5" cy="13" r="1.2" fill="currentColor"/><circle cx="11" cy="13" r="1.2" fill="currentColor"/></svg>
              </div>
              <span class="stop-index">${globalIndex + 1}</span>
            </div>
          </div>
          <h3 class="card-title" title="${escapeHtml(place.name)}">${escapeHtml(place.name)}</h3>
        </div>
        <div class="card-desc"${place.desc ? ` title="${escapeHtml(place.desc)}"` : ''}>${place.desc ? renderDescHtml(place.desc) : 'No notes added.'}</div>
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
          <span class="reorder-hint">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="5" cy="3" r="1.2" fill="currentColor"/><circle cx="11" cy="3" r="1.2" fill="currentColor"/><circle cx="5" cy="8" r="1.2" fill="currentColor"/><circle cx="11" cy="8" r="1.2" fill="currentColor"/><circle cx="5" cy="13" r="1.2" fill="currentColor"/><circle cx="11" cy="13" r="1.2" fill="currentColor"/></svg>
            Drag to reorder
          </span>
          <div class="footer-actions">
            <button class="text-btn edit-btn" onclick="startEdit('${place.id}')">Edit</button>
            <button class="text-btn delete-btn ${isConfirming ? 'confirming' : ''}" onclick="requestDelete('${place.id}')">${isConfirming ? 'Confirm?' : 'Remove'}</button>
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
      const costLineHtml = placePkg
        ? `<div class="route-cost packaged-line"><span class="included-pill">${escapeHtml(placePkg.name)}</span><span class="package-price">$${(parseFloat(placePkg.cost) || 0).toFixed(2)} <span class="price-note">total</span></span></div>`
        : (place.cost != null && place.cost !== '' ? `<div class="route-cost">${parseFloat(place.cost) === 0 ? 'Free' : '$' + parseFloat(place.cost).toFixed(2)}</div>` : '');
      const routeWebsiteUrl = normalizeWebsiteUrl(place.website);
      const routeMapsUrl = place.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.address)}` : null;
      const routeCitymapperUrl = buildCitymapperUrl(place);
      const item = document.createElement('div');
      item.className = 'route-item';
      item.dataset.id = place.id;
      item.draggable = true;
      item.tabIndex = 0;
      item.setAttribute('aria-label', `${place.name}, stop ${gi + 1}. Press Alt plus arrow keys to reorder.`);
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
          <h4 class="route-title" title="${escapeHtml(place.name)}">${escapeHtml(place.name)}</h4>
          <div class="route-desc"${place.desc ? ` title="${escapeHtml(place.desc)}"` : ''}>${place.desc ? renderDescHtml(place.desc) : (place.address ? escapeHtml(place.address) : '')}</div>
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
