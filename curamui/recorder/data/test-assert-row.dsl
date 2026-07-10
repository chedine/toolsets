click section "HCR Cases and Outcomes"
toggle shortcuts panel 
click shortcutgroup "Searches"
click shortcutitem Searches > Person
enter "bo" as First Name
click button "Search"
click link in "Search Results" where Address = "14kl, Dakota, Minnesota, 55124"
click link in "Current Cases" where Type = "Insurance Affordability"
select nav "Home"
click link in "Cases" where Name = "Medical Assistance"
select nav "Determinations"
select navitem "Current Determination"
expect row where Coverage Period = "1/1/2027 - 12/31/2027" and Decision = "Eligible"
click link in "" where Decision = "Eligible"
expect "Decision" is "Eligible"
